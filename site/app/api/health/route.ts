import { NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

/**
 * Liveness, and — only for a caller holding the key — diagnostics.
 *
 * This endpoint used to answer every anonymous request with the full
 * NEXTAUTH_URL, the last six characters of GOOGLE_CLIENT_ID, the database
 * hostname, the number of rows in `site_users`, and the raw text of any
 * connection error. That is a map of the deployment, handed to whoever asks.
 *
 * The split: liveness stays public, because an uptime monitor needs it and
 * `ok` / `degraded` tells an attacker nothing they could not learn by loading
 * the site. Everything else needs `x-health-key`. With HEALTH_DETAIL_KEY unset,
 * detail is unavailable to everyone — there is deliberately no bootstrap-open
 * mode, since a default that grants access is the mistake this phase exists to
 * correct.
 */

/** Length-independent comparison, so a timing signal cannot recover the key. */
function keyMatches(supplied: string | null): boolean {
  const expected = process.env.HEALTH_DETAIL_KEY ?? '';
  if (expected.length < 16 || !supplied) return false;

  // Walk a fixed width regardless of the lengths involved, and fold the length
  // difference in, so neither the comparison nor an early return leaks a prefix.
  const width = Math.max(expected.length, supplied.length);
  let diff = expected.length ^ supplied.length;
  for (let i = 0; i < width; i++) {
    diff |= (expected.charCodeAt(i % expected.length) || 0) ^ (supplied.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function probe(sql: string): Promise<'ok' | 'unexpected' | 'error'> {
  try {
    const client = makeClient();
    await client.connect();
    const result = await client.query(sql);
    await client.end();
    return result.rows.length > 0 ? 'ok' : 'unexpected';
  } catch (err) {
    // The class of failure is what the caller gets; the message names hosts and
    // roles, so it goes to the server log where the operator can still read it.
    console.error('[health] probe failed:', err instanceof Error ? err.message : String(err));
    return 'error';
  }
}

export async function GET(request: Request) {
  const present = {
    NEXTAUTH_URL: Boolean(process.env.NEXTAUTH_URL),
    NEXTAUTH_SECRET: Boolean(process.env.NEXTAUTH_SECRET || process.env.APP_SECRET),
    GOOGLE_CLIENT_ID: Boolean(process.env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    POSTGRES_URL: Boolean(process.env.POSTGRES_URL),
  };

  const db = await probe('SELECT 1 AS ok');
  const users = db === 'ok' ? await probe('SELECT 1 FROM site_users LIMIT 1') : 'error';

  const healthy = Object.values(present).every(Boolean) && db === 'ok' && users === 'ok';
  const status = healthy ? 'ok' : 'degraded';
  const httpStatus = healthy ? 200 : 503;

  if (!keyMatches(request.headers.get('x-health-key'))) {
    // Public answer: enough for a monitor, nothing for a stranger.
    return NextResponse.json({ status }, { status: httpStatus });
  }

  return NextResponse.json(
    { status, checks: { env: present, db, site_users: users } },
    { status: httpStatus }
  );
}