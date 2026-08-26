/**
 * Database client shim.
 *
 * Wraps the `postgres` package (porsager/postgres) so it returns
 * `{ rows }` objects — the same shape as @vercel/postgres — letting the
 * rest of the codebase stay unchanged while connecting to any Postgres
 * provider (local Docker, Supabase, Neon, etc.) via a standard TCP URL.
 *
 * Set POSTGRES_URL in .env.local (or Vercel env) to your connection string.
 */

import postgresLib from 'postgres';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = Record<string, any>;
type SqlResult<T extends AnyRow = AnyRow> = { rows: T[] };

let _client: ReturnType<typeof postgresLib> | null = null;

function getClient(): ReturnType<typeof postgresLib> {
  if (!_client) {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error('POSTGRES_URL environment variable is not set');
    _client = postgresLib(url, {
      ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : 'require',
      onnotice: () => {}, // suppress CREATE TABLE IF NOT EXISTS notices
    });
  }
  return _client;
}

/**
 * Tagged template literal that returns `{ rows: T[] }` — drop-in for
 * the `sql` export from @vercel/postgres.
 *
 * Usage:
 *   const { rows } = await sql`SELECT * FROM foo WHERE id = ${id}`;
 */
export async function sql<T extends AnyRow = AnyRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<SqlResult<T>> {
  const client = getClient();
  // The postgres package returns a RowList which is array-like; cast to array
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (client as any)(strings, ...values) as Promise<T[]>;
  const rows = await result;
  return { rows: Array.isArray(rows) ? rows : [...(rows as Iterable<T>)] };
}

/**
 * Run a PRE-WRITTEN, PARAMETERIZED statement with `$1`-style placeholders.
 *
 * "Unsafe" is the postgres package's name for "text I did not build from a
 * tagged template", not an invitation: the only legitimate callers pass
 * CONSTANTS (the KPI statements in lib/kpiSql.ts, telemetry DDL in
 * lib/kpi.ts) with values strictly in `params`. Never interpolate input into
 * `text`.
 */
export async function sqlUnsafe<T extends AnyRow = AnyRow>(
  text: string,
  params: unknown[] = []
): Promise<SqlResult<T>> {
  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (client as any).unsafe(text, params as any[])) as T[];
  return { rows: Array.isArray(rows) ? rows : [...(rows as Iterable<T>)] };
}
