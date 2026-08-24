/**
 * A recording stand-in for a pg client, for tests that are about WHAT IS
 * WRITTEN rather than about what Postgres does with it.
 *
 * ── Why this exists, given three suites already use a real Postgres ───────
 *
 * `creditLedger`, `progressLedger` and `leaderboard` all test against a real
 * database, and they are right to: their guarantees are `ON CONFLICT`, `FOR
 * UPDATE` and a `FROM` clause, and none of those can be demonstrated by a fake.
 * Those suites skip when `POSTGRES_TEST_URL` is absent.
 *
 * Some of this phase's guarantees are of a different kind. "The owner CRUD
 * stamps `server_id`" is a claim about the SQL this app emits, not about how
 * Postgres executes it — and a claim about emitted SQL is exactly what a
 * recording client can settle, on every machine, with no database. A test that
 * only runs where a database happens to exist is a gate that measures nothing on
 * the machines where it does not, and that failure shape has cost this
 * repository more than once.
 *
 * So: both. The recording client pins the stamp everywhere; the integration
 * suite pins the consequence — that a stamped quest cannot move a global board —
 * where a database is available.
 *
 * Test-only. Nothing under `app/` or `components/` imports it, exactly as
 * `components/diorama/testCtx.ts` is test-only.
 */

import type { Client } from 'pg';

export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => Array<Record<string, unknown>> | undefined;

export interface FakeDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;
  /** Every statement issued, in order. */
  readonly log: RecordedQuery[];
  /** Statements whose text contains `needle` (whitespace-insensitive). */
  matching(needle: string): RecordedQuery[];
  /** The one statement matching `needle`; throws unless there is exactly one. */
  only(needle: string): RecordedQuery;
  clear(): void;
}

/** Collapse whitespace so a match is not defeated by the SQL's own formatting. */
export function flat(sql: string): string {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/**
 * @param respond decides the rows for a statement. Returning `undefined` means
 *   "no rows", which is the right default: a query whose answer a test has not
 *   arranged should behave like an empty table rather than like a fixture the
 *   test forgot it was relying on.
 *
 * The return type is intersected with `Client` so a fake can be passed straight
 * to a `(db: Db, ...)` function without a cast at every call site. ONE cast,
 * here, rather than dozens in the tests — and the modules under test only ever
 * call `.query`, so the properties this object does not have are properties
 * nothing reaches for. A module that grew a `db.release()` would fail at
 * runtime in the very test that called it, which is the right place to find out.
 */
export function makeFakeDb(respond: Responder = () => undefined): FakeDb & Client {
  const log: RecordedQuery[] = [];
  const db: FakeDb = {
    log,
    async query(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      const rows = respond(flat(sql), params) ?? [];
      return { rows, rowCount: rows.length };
    },
    matching(needle: string) {
      const want = flat(needle);
      return log.filter((q) => flat(q.sql).includes(want));
    },
    only(needle: string) {
      const found = db.matching(needle);
      if (found.length !== 1) {
        throw new Error(
          `expected exactly one statement matching ${JSON.stringify(needle)}, found ${found.length}`
        );
      }
      return found[0];
    },
    clear() {
      log.length = 0;
    },
  };
  return db as FakeDb & Client;
}
