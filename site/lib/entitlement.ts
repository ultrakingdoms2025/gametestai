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
};

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

/** Grant access and add credits, preserving anything already bought. */
export async function grant(opts: { paid?: boolean; addCredits?: number }): Promise<Pass> {
  const current = await readPass();
  const next: Pass = {
    v: VERSION,
    paid: opts.paid ?? current?.paid ?? false,
    credits: (current?.credits ?? 0) + Math.max(0, Math.floor(opts.addCredits ?? 0)),
    iat: Math.floor(Date.now() / 1000),
  };
  await writePass(next);
  return next;
}

/**
 * Hand the purchased credits to the game and zero the balance held here.
 *
 * The site is a shop, not a save file: once the game has taken delivery the
 * balance belongs to the save, and leaving a copy here would let the same
 * purchase be claimed twice by reloading.
 */
export async function claimCredits(): Promise<number> {
  const current = await readPass();
  if (!current || current.credits <= 0) return 0;
  const taken = current.credits;
  await writePass({ ...current, credits: 0, iat: Math.floor(Date.now() / 1000) });
  return taken;
}
