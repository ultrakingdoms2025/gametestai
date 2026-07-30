import { NextRequest, NextResponse } from 'next/server';
import { getUserByEmail, createUser } from '@/lib/db';
import { isHandleAvailable, normalizeHandle, syncPlayerProfile } from '@/lib/playerDb';

export async function POST(req: NextRequest) {
  try {
    const { email, password, handle } = await req.json();
    if (!email || !password || !handle || typeof email !== 'string' || typeof password !== 'string' || typeof handle !== 'string') {
      return NextResponse.json({ error: 'Email, handle, and password are required.' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    }
    const normalizedHandle = normalizeHandle(handle);
    if (normalizedHandle.length < 3) {
      return NextResponse.json({ error: 'Handle must be at least 3 characters.' }, { status: 400 });
    }
    const normalized = email.toLowerCase().trim();
    const existing = await getUserByEmail(normalized);
    if (existing) {
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 });
    }
    if (!(await isHandleAvailable(normalizedHandle))) {
      return NextResponse.json({ error: 'That handle is already in use.' }, { status: 409 });
    }
    const user = await createUser({ email: normalized, password });
    await syncPlayerProfile(user.id, normalized, {
      handle: normalizedHandle,
      fullName: normalizedHandle,
      overwrite: true,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[register]', err);
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
