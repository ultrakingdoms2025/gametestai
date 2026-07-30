import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { setTotpSecret } from '@/lib/db';

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  await setTotpSecret(session.user.id, null, false);
  return NextResponse.json({ ok: true });
}
