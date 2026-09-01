import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loginSchema } from '@/lib/validate';
import { findAdminByUsername, touchAdminLogin, audit } from '@/lib/db';
import { decrypt } from '@/lib/encrypt';
import { verifyTotp } from '@/lib/totp';
import { getSession } from '@/lib/session';
import {
  LOCKOUT_MINUTES,
  clearLoginFailures,
  clientIp,
  noteLoginAttempt,
  recordLoginFailure,
} from '@/lib/loginThrottle';

/**
 * The admin login.
 *
 * The throttle lives here rather than in `proxy.ts` for one reason: the proxy
 * cannot see the submitted username without consuming the request body, and a
 * limit keyed only on an address is no limit against a guessing run spread
 * across many addresses. See `lib/loginThrottle.ts` for what the in-memory Map
 * this replaces was actually counting (and why the answer was "nothing").
 *
 * Every response below is deliberately shaped the same: one sentence, no
 * distinction between "no such account", "wrong password" and "wrong code".
 * The audit chain records which it was; the caller is told only that it failed.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }
  const { username, password, totp } = parsed.data;
  const ip = clientIp(req.headers);

  /* Counted before anything is checked, so a request that never reaches bcrypt
   * still costs the attacker one of their attempts. A throttle that only counts
   * requests it has already done the expensive work for is a throttle that
   * cannot protect the expensive work. */
  const verdict = await noteLoginAttempt(username, ip);
  if (!verdict.allowed) {
    await audit('system', 'auth.login_blocked', `admin:${username}`, verdict.reason, ip);
    return NextResponse.json(
      { error: 'Too many login attempts' },
      { status: 429, headers: { 'Retry-After': String(verdict.retryAfterSeconds) } }
    );
  }

  const admin = await findAdminByUsername(username);
  if (!admin) {
    // Constant-time: still run bcrypt to prevent timing attacks
    await bcrypt.compare(password, '$2b$12$invalidhashpadding00000000000000000000000000000000');
    await noteFailure(username, ip, 'no_such_admin');
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const pwOk = await bcrypt.compare(password, admin.password_hash);
  if (!pwOk) {
    await noteFailure(username, ip, 'bad_password');
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  let totpSecret: string;
  try {
    totpSecret = decrypt(admin.totp_secret);
  } catch {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  if (!verifyTotp(totpSecret, totp)) {
    await noteFailure(username, ip, 'bad_totp');
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 });
  }

  const session = await getSession();
  session.adminId  = admin.id;
  session.username = admin.username;
  session.loginAt  = Date.now();
  await session.save();

  /* Only a login that passed BOTH factors clears the count. A correct password
   * with a wrong code must not buy the attacker a fresh allowance. */
  await clearLoginFailures(username, ip);
  await touchAdminLogin(admin.id);
  await audit(admin.username, 'auth.login', `admin:${admin.id}`, undefined, ip);

  return NextResponse.json({ ok: true });
}

/**
 * Record one failure, and say in the log when it was the one that locked the
 * account. `auth.login_fail` rows existed before and nothing acted on them;
 * now the row that trips the lockout says so, so the audit page shows when a
 * grind started rather than only that it happened.
 */
async function noteFailure(username: string, ip: string, why: string): Promise<void> {
  const locked = await recordLoginFailure(username, ip);
  await audit(
    'system',
    'auth.login_fail',
    `admin:${username}`,
    locked ? `${why}; locked out for ${LOCKOUT_MINUTES} minutes` : why,
    ip
  );
}
