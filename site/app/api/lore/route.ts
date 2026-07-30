import { NextResponse } from 'next/server';
import { sql } from '@vercel/postgres';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS lore_entries (
        scope       TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        sign_label  TEXT NOT NULL DEFAULT 'Lorekeeper',
        body        TEXT NOT NULL,
        updated_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const { rows } = await sql`
      SELECT scope, title, sign_label, body, updated_at
      FROM lore_entries
      ORDER BY CASE scope
        WHEN 'overall' THEN 0
        WHEN 'station' THEN 1
        WHEN 'medieval' THEN 2
        WHEN 'sports' THEN 3
        WHEN 'citadel' THEN 4
        WHEN 'race' THEN 5
        ELSE 99
      END, scope
    `;

    const entries = Object.fromEntries(
      rows.map((row) => [
        String(row.scope),
        {
          scope: String(row.scope),
          title: String(row.title ?? ''),
          sign_label: String(row.sign_label ?? 'Lorekeeper'),
          body: String(row.body ?? ''),
          updated_at: row.updated_at,
        },
      ])
    );

    return NextResponse.json({ entries });
  } catch (error) {
    console.error('[lore] failed to load lore entries:', error);
    return NextResponse.json({ error: 'Lore data unavailable.' }, { status: 503 });
  }
}
