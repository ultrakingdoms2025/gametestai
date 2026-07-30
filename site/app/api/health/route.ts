import { NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, string> = {};

  checks.NEXTAUTH_URL = process.env.NEXTAUTH_URL ? `set (${process.env.NEXTAUTH_URL})` : 'MISSING';
  checks.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ? 'set' : (process.env.APP_SECRET ? 'fallback(APP_SECRET)' : 'MISSING');
  checks.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ? `set (...${process.env.GOOGLE_CLIENT_ID.slice(-6)})` : 'MISSING';
  checks.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ? 'set' : 'MISSING';
  checks.POSTGRES_URL = process.env.POSTGRES_URL ? 'set' : 'MISSING';

  try {
    const client = new Client({ connectionString: process.env.POSTGRES_URL });
    await client.connect();
    const result = await client.query('SELECT 1 AS ok');
    await client.end();
    checks.db = result.rows[0]?.ok === 1 ? 'connected' : 'unexpected result';
  } catch (err) {
    checks.db = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const client = new Client({ connectionString: process.env.POSTGRES_URL });
    await client.connect();
    const result = await client.query('SELECT COUNT(*) AS n FROM site_users');
    await client.end();
    checks.site_users = `ok (${result.rows[0]?.n} rows)`;
  } catch (err) {
    checks.site_users = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  const allOk = !Object.values(checks).some(v => v.startsWith('MISSING') || v.startsWith('ERROR'));
  return NextResponse.json({ status: allOk ? 'ok' : 'degraded', checks }, { status: allOk ? 200 : 503 });
}