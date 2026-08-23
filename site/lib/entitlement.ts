import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Who has paid, and for what.
 *
 * ## What this is, and what it is not
 *
 * A signed cookie. The payload is readable by anyone who looks — it is not
 * encrypted and does not need to be, since it says nothing secret — but it
 * cannot be *edited*, because the signature is an HMAC over the payload with a
 * server-side key. Change the credit count in devtools and the signature stops
 * matching and the pass is rejected.
 *
 * It is deliberately not a user account. There is no database in this project
 * and no login, so a pass is bound to a browser rather than to a person:
 * clearing cookies loses it, and a second device does not have it. That is the
 * honest limit of a cookie-based entitlement and it is the right trade for a
 * one-dollar unlock — but it is a limit, and the moment real money and real
 * support tickets are involved this wants to become a row in a table keyed on
 * an account. That is a deliberate follow-up, not an oversight.
 *
 * ## The secret
 *
 * `APP_SECRET` must be set in production. Without it the signing key is a known
 * constant, which means anyone can mint their own pass — so an unset secret is
 * reported loudly rather than silently accepted.
 */

const COOKIE = 'an_pass';
const VERSION = 1;
/** A pass is good for a year. Long, because it represents a purchase. */
const MAX_AGE_S = 60 * 60 * 24 * 365;

const DEV_SECRET = 'aether-nexus-development-key-do-not-ship';

export type Pass = {
  v: number;
  /** Has the one-off access charge been paid. */
  paid: boolean;
  /** Credits bought through the store and not yet handed to the game. */
  credits: number;
  /** Issued-at, epoch seconds. */
  iat: number;
  /**
   * Fingerprints of orders already granted, newest last.
   *
   * Without this the success URL is a credit generator: `/api/confirm` grants
   * on every request, so refreshing the page after paying adds the credits
   * again, and so does going back to it later from history. Recording what has
   * been settled makes the grant idempotent, which is the property a payment
   * return path has to have — it is a URL in someone's browser, and browsers
   * re-request URLs for all sorts of reasons nobody controls.
   *
   * Capped, because this rides in a cookie and cookies have a size limit. A
   * dozen is far more than the number of orders that can be in flight at once,
   * and the entries that fall off the end are old settled orders that Stripe
   * will not be replaying.
   */
  seen: string[];
};

/** How many settled orders to remember. */
const SEEN_MAX = 12;

/**
 * Short fingerprint of an order id.
 *
 * Hashed rather than stored whole to keep the cookie small, and truncated to
 * 48 bits — for a per-browser list of twelve, the chance of a collision is far
 * below the chance of any other part of this going wrong.
 */
export function fingerprint(id: string): string {
  return createHmac('sha256', 'order').update(id).digest('hex').slice(0, 12);
}

let warned = false;

function secret(): string {
  const s = process.env.APP_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production' && !warned) {
    warned = true;
    console.error(
      '[entitlement] APP_SECRET is unset or too short. Passes are being signed '
      + 'with a public constant, so anyone can forge one. Set APP_SECRET to a '
      + 'random 32-byte value before taking real payments.'
    );
  }
  return s && s.length > 0 ? s : DEV_SECRET;
}

function sign(body: string): string {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function sigEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodePass(pass: Pass): string {
  const body = Buffer.from(JSON.stringify(pass)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodePass(raw: string | undefined | null): Pass | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!sigEquals(sig, sign(body))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!parsed || parsed.v !== VERSION) return null;
    return {
      v: VERSION,
      paid: !!parsed.paid,
      credits: Math.max(0, Math.floor(Number(parsed.credits) || 0)),
      iat: Number(parsed.iat) || 0,
      seen: Array.isArray(parsed.seen)
        ? parsed.seen.filter((s: unknown) => typeof s === 'string').slice(-SEEN_MAX)
        : [],
    };
  } catch {
    // A malformed body that nonetheless carried a valid signature is not
    // something an attacker can produce, so this is corruption, not an attack.
    return null;
  }
}

/** The pass on the current request, or null. Safe in server components. */
export async function readPass(): Promise<Pass | null> {
  const jar = await cookies();
  return decodePass(jar.get(COOKIE)?.value);
}

/**
 * Write a pass.
 *
 * Only valid inside a Route Handler or Server Action — Next.js does not allow a
 * Server Component to set a cookie, because by the time it renders the response
 * headers are already committed.
 */
export async function writePass(pass: Pass): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE, encodePass(pass), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_S,
  });
}

export type GrantResult = { pass: Pass; applied: boolean };

/**
 * Grant browser-scoped access, once per order.
 *
 * Access only. Credits are the account's, granted by `recordSitePurchase` at
 * checkout and held in `players.credit_balance`; this cookie used to add its
 * own copy alongside, which nothing ever collected. See the `credits` line
 * below and the note where `claimCredits` used to be.
 *
 * `orderId` still makes this idempotent, because settling the same order twice
 * must not re-grant access either. Callers that genuinely have no order — there
 * are none right now — can omit it, and then it is the caller's problem.
 */
export async function grant(opts: {
  paid?: boolean;
  orderId?: string;
}): Promise<GrantResult> {
  const current = await readPass();
  const seen = current?.seen ?? [];

  if (opts.orderId) {
    const fp = fingerprint(opts.orderId);
    if (seen.includes(fp)) {
      // Already settled. Return what they have without touching it.
      return { pass: current ?? emptyPass(), applied: false };
    }
    seen.push(fp);
  }

  const next: Pass = {
    v: VERSION,
    paid: opts.paid ?? current?.paid ?? false,
    /* NOT `+ addCredits`. This cookie stopped being an accounting record when
     * the credit ledger landed: `recordSitePurchase` credits
     * `players.credit_balance` at purchase time, idempotently per order, and
     * that balance is the only one there is. Adding here as well produced a
     * second, browser-held credit number - precisely the thing Phase 2 removed
     * - which nothing ever drained, because `claimCredits` had no callers.
     *
     * Existing cookies keep whatever number they were carrying; it is ignored,
     * and the purchases it represents are already in the server balance.
     * `paid` still lives here, because access entitlement genuinely is a
     * browser-scoped thing. */
    credits: current?.credits ?? 0,
    iat: Math.floor(Date.now() / 1000),
    seen: seen.slice(-SEEN_MAX),
  };
  await writePass(next);
  return { pass: next, applied: true };
}

function emptyPass(): Pass {
  return { v: VERSION, paid: false, credits: 0, iat: Math.floor(Date.now() / 1000), seen: [] };
}

/* `claimCredits` was here: it zeroed the cookie's credit field and returned the
 * amount, for a caller that would hand it to the game.
 *
 * It never had one. Not a single call site, in any app, at any point - so every
 * credit ever written to that field is still sitting in it, and the store page
 * told anyone who had paid that their credits were "not yet collected" and
 * would arrive "the next time you enter the game". Both halves were false: the
 * purchase had already been added to `players.credit_balance` by
 * `recordSitePurchase`, and nothing was ever going to collect the cookie copy.
 *
 * Deleted rather than wired up, because wiring it up would recreate the hole
 * Phase 2 closed - a browser handing the server a credit figure. */

/** Has this order already been settled on this browser? */
export async function alreadySettled(orderId: string): Promise<boolean> {
  const current = await readPass();
  return !!current?.seen?.includes(fingerprint(orderId));
}
