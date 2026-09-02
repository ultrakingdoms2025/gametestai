import { appSecret } from './appSecret';

const COOKIE = 'an_game_launch';
const MAX_AGE_S = 60 * 60 * 8;

/**
 * The key the launch cookie is signed with.
 *
 * This used to fall through to a constant published in this repository, which
 * meant a deployment without the variable could have its launch cookie forged
 * by anyone -- and the launch cookie is the ONLY thing `proxy.ts` checks before
 * serving `/game/*`, so forging one is the paywall.
 *
 * It also read `APP_SECRET` before `NEXTAUTH_SECRET`, the opposite order to
 * `lib/auth.ts` and `lib/telemetry.ts`. A deployment that set both signed its
 * launch cookies with one key and its sessions with another -- harmless in
 * itself, and exactly the sort of quiet disagreement that makes a later
 * key rotation half-work. One order, in one place: see `lib/appSecret.ts`.
 */
function secret(): string {
  return appSecret();
}

function encodeBody(body: string): string {
  return encodeURIComponent(body);
}

function decodeBody(body: string): string | null {
  try {
    return decodeURIComponent(body);
  } catch {
    return null;
  }
}

async function hmac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function launchCookieName(): string {
  return COOKIE;
}

export function launchCookieMaxAge(): number {
  return MAX_AGE_S;
}

export async function createLaunchCookieValue(userId: string): Promise<string> {
  const body = JSON.stringify({
    u: userId,
    exp: Date.now() + MAX_AGE_S * 1000,
  });
  return `${encodeBody(body)}.${await hmac(body)}`;
}

export async function verifyLaunchCookieValue(raw: string | undefined, userId: string): Promise<boolean> {
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return false;

  const body = decodeBody(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!body) return false;
  if (sig !== await hmac(body)) return false;

  try {
    const parsed = JSON.parse(body) as { u?: unknown; exp?: unknown };
    return parsed.u === userId
      && typeof parsed.exp === 'number'
      && Number.isFinite(parsed.exp)
      && Date.now() < parsed.exp;
  } catch {
    return false;
  }
}
