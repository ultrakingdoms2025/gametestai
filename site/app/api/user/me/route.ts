import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserById } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const user = await getUserById(session.user.id);
  if (!user) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  return NextResponse.json({
    id: user.id,
    email: user.email,
    totp_enabled: user.totp_enabled,
    has_password: !!user.password_hash,
    has_google: !!user.google_id,
  });
}
