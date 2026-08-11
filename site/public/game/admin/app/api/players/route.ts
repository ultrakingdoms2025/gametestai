import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { listPlayers, revokeAccess, adjustCredits, audit } from '@/lib/db';
import { playerQuerySchema, revokeSchema, creditSchema } from '@/lib/validate';

export async function GET(req: NextRequest) {
  const { username } = await requireSession();
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const { page, search } = playerQuerySchema.parse(q);
  const rows = await listPlayers(page, search);
  await audit(username, 'player.list', 'players', `page=${page}`);
  return NextResponse.json({ rows });
}

export async function PATCH(req: NextRequest) {
  const { username } = await requireSession();
  const body = await req.json().catch(() => null);

  // Revoke access
  const rev = revokeSchema.safeParse(body);
  if (rev.success) {
    await revokeAccess(rev.data.playerId);
    await audit(username, 'player.revoke_access', `player:${rev.data.playerId}`, rev.data.reason);
    return NextResponse.json({ ok: true });
  }

  // Adjust credits
  const cred = creditSchema.safeParse(body);
  if (cred.success) {
    await adjustCredits(cred.data.playerId, cred.data.delta);
    await audit(username, 'player.adjust_credits', `player:${cred.data.playerId}`,
                `delta=${cred.data.delta} reason=${cred.data.reason ?? '—'}`);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
}