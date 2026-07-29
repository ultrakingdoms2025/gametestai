import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { audit } from '@/lib/db';

export async function POST() {
  const session = await getSession();
  if (session.adminId) {
    await audit(session.username, 'auth.logout', `admin:${session.adminId}`);
  }
  session.destroy();
  return NextResponse.json({ ok: true });
}