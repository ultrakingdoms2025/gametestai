import { NextResponse } from 'next/server';
import { getLoreEntries } from '@/lib/lore';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rows = await getLoreEntries();
    const entries = Object.fromEntries(rows.map(r => [r.scope, {
      scope: r.scope, title: r.title, sign_label: r.sign_label, body: r.body, updated_at: r.updated_at,
    }]));
    return NextResponse.json({ entries });
  } catch (error) {
    console.error('[lore] failed to load lore entries:', error);
    return NextResponse.json({ error: 'Lore data unavailable.' }, { status: 503 });
  }
}
