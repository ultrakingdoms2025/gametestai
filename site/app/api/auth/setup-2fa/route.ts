import { NextRequest, NextResponse } from 'next/server';
import { toDataURL } from 'qrcode';
import { auth } from '@/lib/auth';
import { getUserById, setTotpSecret } from '@/lib/db';
import { base32Encode, verifyTotp, generateTotpSecret } from '@/lib/totp';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const secret = generateTotpSecret();
  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

  const otpauth = `otpauth://totp/Aether%20Nexus:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Aether%20Nexus`;
  const qrDataUrl = await toDataURL(otpauth);

  // Store secret temporarily — user confirms with a code before we mark totp_enabled=true
  await setTotpSecret(session.user.id, secret, false);

  return NextResponse.json({ secret, qrDataUrl });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const { code } = await req.json();
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Code is required.' }, { status: 400 });
  }

  const user = await getUserById(session.user.id);
  if (!user?.totp_secret) return NextResponse.json({ error: 'Setup not started.' }, { status: 400 });

  const valid = verifyTotp(user.totp_secret, code.trim());
  if (!valid) return NextResponse.json({ error: 'Invalid code. Try again.' }, { status: 400 });

  await setTotpSecret(session.user.id, user.totp_secret, true);
  return NextResponse.json({ ok: true });
}
