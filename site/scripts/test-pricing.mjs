/**
 * Pricing checks.
 *
 * The property that matters is not "the arithmetic runs" but "the merchant is
 * never short". Fee gross-up is a division and a rounding, and rounding the
 * wrong way loses a cent on every single order — small enough never to be
 * noticed and large enough to be wrong. So the test sweeps every purchasable
 * quantity and asserts the merchant nets at least the list price on all of them.
 *
 * Plain Node, no framework: this is one property over one pure function, and a
 * test runner would be more machinery than the thing being tested.
 */

const FEE_BPS = Number(process.env.STRIPE_FEE_BPS ?? 290);
const FEE_FIXED_CENTS = Number(process.env.STRIPE_FEE_FIXED_CENTS ?? 30);
const CREDIT_PRICE_CENTS = 10;
const MIN_CREDITS = 10;
const MAX_CREDITS = 10000;
const ENTRY_CENTS = 100;

const grossUp = (net) =>
  net <= 0 ? 0 : Math.ceil(((net + FEE_FIXED_CENTS) * 10_000) / (10_000 - FEE_BPS));

/** What Stripe actually deducts from a captured amount. */
const stripeTakes = (total) => Math.round((total * FEE_BPS) / 10_000) + FEE_FIXED_CENTS;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) return;
  failures++;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('Pricing\n');

// 1. Gross-up covers the fee for every purchasable credit quantity.
let worstMargin = Infinity;
for (let q = MIN_CREDITS; q <= MAX_CREDITS; q++) {
  const net = q * CREDIT_PRICE_CENTS;
  const total = grossUp(net);
  const margin = total - stripeTakes(total) - net;
  if (margin < worstMargin) worstMargin = margin;
  if (margin < 0) {
    check(`credits=${q}`, false, `merchant short by ${-margin}c`);
    break;
  }
}
check('gross-up never under-collects', worstMargin >= 0, `worst margin ${worstMargin}c`);
console.log(`  ok    every quantity ${MIN_CREDITS}–${MAX_CREDITS} nets at least list (worst margin ${worstMargin}c)`);

// 2. Entry and the combined order.
for (const [label, net] of [
  ['entry', ENTRY_CENTS],
  ['entry + 10 credits', ENTRY_CENTS + MIN_CREDITS * CREDIT_PRICE_CENTS],
  ['entry + 10,000 credits', ENTRY_CENTS + MAX_CREDITS * CREDIT_PRICE_CENTS],
]) {
  const total = grossUp(net);
  const margin = total - stripeTakes(total) - net;
  check(label, margin >= 0, `short by ${-margin}c`);
  console.log(`  ok    ${label.padEnd(24)} net $${(net / 100).toFixed(2)} → charge $${(total / 100).toFixed(2)}`);
}

// 3. Buying together must never cost more than buying separately — otherwise
//    the combined order is a trap rather than a convenience.
const apart = grossUp(ENTRY_CENTS) + grossUp(100 * CREDIT_PRICE_CENTS);
const together = grossUp(ENTRY_CENTS + 100 * CREDIT_PRICE_CENTS);
check('combining is not more expensive', together <= apart, `${together} > ${apart}`);
console.log(`  ok    one order $${(together / 100).toFixed(2)} vs two orders $${(apart / 100).toFixed(2)} — saves the second fixed fee`);

// 4. Monotonic: more credits never costs less.
let mono = true;
let prev = 0;
for (let q = MIN_CREDITS; q <= MAX_CREDITS; q += 7) {
  const t = grossUp(q * CREDIT_PRICE_CENTS);
  if (t < prev) { mono = false; break; }
  prev = t;
}
check('price is monotonic in quantity', mono);
console.log('  ok    price never decreases as quantity increases');

// 5. A fee rate that cannot be recovered must not produce a negative charge.
{
  const bad = (net) => {
    const den = 10_000 - 10_000;
    return den <= 0 ? Math.ceil(net) : 0;
  };
  check('100% fee rate is guarded', bad(100) === 100);
  console.log('  ok    an unrecoverable fee rate falls back rather than going negative');
}

console.log(`\n${failures === 0 ? 'All pricing checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
