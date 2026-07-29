import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { loginSchema } from '@/lib/validate';
import { findAdminByUsername, touchAdminLogin, audit } from '@/lib/db';
import { decrypt } from '@/lib/encrypt';
import { verifyTotp } from '@/lib/totp';
import { getSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }
  const { username, password, totp } = parsed.data;

  const admin = await findAdminByUsername(username);
  if (!admin) {
    // Constant-time: still run bcrypt to prevent timing attacks
    await bcrypt.compare(password, '$2b$12$invalidhashpadding00000000000000000000000000000000');
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const pwOk = await bcrypt.compare(password, admin.password_hash);
  if (!pwOk) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    await audit('system', 'auth.login_fail', `admin:${username}`, 'bad_password', ip);
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  let totpSecret: string;
  try {
    totpSecret = decrypt(admin.totp_secret);
  } catch {
    return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
  }

  if (!verifyTotp(totpSecret, totp)) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    await audit('system', 'auth.login_fail', `admin:${username}`, 'bad_totp', ip);
    return NextResponse.json({ error: 'Invalid TOTP code' }, { status: 401 });
  }

  const session = await getSession();
  session.adminId  = admin.id;
  session.username = admin.username;
  session.loginAt  = Date.now();
  await session.save();

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  await touchAdminLogin(admin.id);
  await audit(admin.username, 'auth.login', `admin:${admin.id}`, undefined, ip);

  return NextResponse.json({ ok: true });
}