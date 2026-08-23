import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getUserByEmail, getUserById, updateUserEmail } from '@/lib/db';
import { findOrCreatePlayer, getPlayerStatus, isEmailClaimedByOtherPlayer, isHandleAvailable, normalizeHandle, syncPlayerProfile } from '@/lib/playerDb';

async function buildResponse(userId: string) {
  const user = await getUserById(userId);
  if (!user) return null;
  await findOrCreatePlayer(userId, user.email);
  const profile = await getPlayerStatus(userId);
  return {
    id: user.id,
    email: user.email,
    handle: profile?.handle ?? '',
    full_name: profile?.fullName ?? '',
    credits: profile?.creditBalance ?? 0,
    has_access: profile?.hasAccess ?? false,
    days_remaining: profile?.daysRemaining ?? 0,
    totp_enabled: user.totp_enabled,
    has_password: !!user.password_hash,
    has_google: !!user.google_id,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const payload = await buildResponse(session.user.id);
  if (!payload) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json(payload);
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const current = await getUserById(session.user.id);
  if (!current) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

  const body = await req.json().catch(() => null) as {
    email?: unknown;
    handle?: unknown;
    full_name?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });

  const email = typeof body.email === 'string' ? body.email.toLowerCase().trim() : current.email;
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
  const rawHandle = typeof body.handle === 'string' ? body.handle : '';
  const handle = normalizeHandle(rawHandle);

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  if (handle.length < 3) {
    return NextResponse.json({ error: 'Handle must be at least 3 characters.' }, { status: 400 });
  }

  const existing = await getUserByEmail(email);
  if (existing && existing.id !== current.id) {
    return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 });
  }

  await findOrCreatePlayer(session.user.id, current.email);
  const currentProfile = await getPlayerStatus(session.user.id);
  if (!(await isHandleAvailable(handle, currentProfile?.playerId)) && currentProfile?.handle?.toLowerCase() !== handle.toLowerCase()) {
    return NextResponse.json({ error: 'That handle is already in use.' }, { status: 409 });
  }

  /* Both uniqueness rules, before either table is written.
   *
   * `site_users.email` was checked above; `players.email_hash` is ALSO unique
   * and was not. Committing the site row first and discovering the collision
   * afterwards left the two tables permanently disagreeing, with no way back:
   * the next attempt collides on the site table instead. */
  if (email !== current.email
      && await isEmailClaimedByOtherPlayer(email, currentProfile?.playerId)) {
    return NextResponse.json(
      { error: 'An account with that email already exists.' },
      { status: 409 }
    );
  }

  if (email !== current.email) {
    await updateUserEmail(current.id, email);
  }

  await syncPlayerProfile(session.user.id, email, {
    handle,
    fullName,
    overwrite: true,
  });

  const payload = await buildResponse(session.user.id);
  return NextResponse.json(payload);
}
