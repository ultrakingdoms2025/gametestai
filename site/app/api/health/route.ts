import { NextResponse } from 'next/server';
import { Client } from 'pg';

export const dynamic = 'force-dynamic';

function makeClient() {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

export async function GET() {
  const checks: Record<string, string> = {};

  const connStr = process.env.POSTGRES_URL ?? '';
  checks.NEXTAUTH_URL = process.env.NEXTAUTH_URL ? `set (${process.env.NEXTAUTH_URL})` : 'MISSING';
  checks.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ? 'set' : (process.env.APP_SECRET ? 'fallback(APP_SECRET)' : 'MISSING');
  checks.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ? `set (...${process.env.GOOGLE_CLIENT_ID.slice(-6)})` : 'MISSING';
  checks.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ? 'set' : 'MISSING';

  // Show the hostname from the connection string to help diagnose wrong URLs
  try {
    const u = new URL(connStr);
    checks.POSTGRES_URL = connStr ? `set (host=${u.hostname})` : 'MISSING';
  } catch {
    checks.POSTGRES_URL = connStr ? 'set (unparseable URL)' : 'MISSING';
  }

  try {
    const client = makeClient();
    await client.connect();
    const result = await client.query('SELECT 1 AS ok');
    await client.end();
    checks.db = result.rows[0]?.ok === 1 ? 'connected' : 'unexpected result';
  } catch (err) {
    checks.db = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }

  try {
    const client = makeClient();
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