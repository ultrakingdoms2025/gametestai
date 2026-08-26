import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A THROWN RESOLVER MUST NEVER FALL BACK IN SILENCE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `serverRoutes.currentContentScope` answers the platform scope on ANY
 * failure, and that direction is right: a database hiccup shows the default
 * catalogue rather than failing the request or serving somebody else's. What
 * cost a live walkthrough was the fallback's SILENCE. The owner created a
 * server, entered it, and the HUD, quests, lore, marketplace and credits were
 * all global — every scoped route had swallowed the same resolver error into
 * `{serverId: null, mode: 'extend'}`, and production showed the symptoms of
 * "player is not in their server" with no log line anywhere saying a resolver
 * had THROWN. A schema error (the `content_mode` column not yet ensured on the
 * database a route first touched) is indistinguishable, from the outside, from
 * a player who never selected a server.
 *
 * So the contract this file pins has two halves, and they are different:
 *
 *   1. "Legitimately no scope" — no selection, lapsed membership — is the
 *      resolver RETURNING the platform scope. Nothing is logged; it is not a
 *      fault.
 *   2. The resolver THROWING is a fault. The fallback still serves the
 *      platform scope (never an error, never someone else's server), but
 *      `console.error` fires first, with the player id and enough words to
 *      find, so production symptoms always have a cause on record.
 *
 * These are unit tests with mocked modules — deliberately, because the case
 * under test is "the database layer is broken", which is exactly the case an
 * integration suite cannot set up against a healthy database. The resolver's
 * own self-ensure (customServers.currentContentScope runs
 * `ensureCustomServerSchema` before it reads) is pinned separately as a source
 * assertion below, because that ensure is what makes the THROW rare in the
 * first place.
 */

vi.mock('pg', () => {
  class Client {
    async connect() {}
    async end() {}
    async query() {
      return { rows: [] };
    }
  }
  return { Client, default: { Client } };
});

vi.mock('./auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('./db', () => ({ getUserById: vi.fn(async () => null) }));
vi.mock('./playerDb', () => ({ findOrCreatePlayer: vi.fn(async () => 'player-x') }));
vi.mock('./adminAllowlist', () => ({ isAllowedAdminEmail: () => false }));
vi.mock('./auditChain', () => ({ appendAudit: vi.fn(async () => {}) }));

const resolverMock = vi.fn();

vi.mock('./customServers', () => ({
  ensureCustomServerSchema: vi.fn(async () => {}),
  currentContentScope: (...args: unknown[]) => resolverMock(...args),
  getServer: vi.fn(async () => null),
}));

import { currentContentScope, currentServer } from './serverRoutes';

const PLAYER = 'player-under-test-77';

describe('the content-scope route wrapper', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resolverMock.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('serves the platform scope AND logs loudly when the resolver throws', async () => {
    resolverMock.mockRejectedValue(new Error('column "content_mode" does not exist'));

    const scope = await currentContentScope(PLAYER);

    /* The fallback: the safe direction, unchanged. */
    expect(scope).toEqual({ serverId: null, mode: 'extend' });

    /* The half that was missing in production: the fault is ON RECORD, with
     * the player attached, before the fallback is served. */
    expect(errorSpy).toHaveBeenCalled();
    const line = errorSpy.mock.calls
      .map((c: unknown[]) => c.map(String).join(' '))
      .find((s: string) => s.includes('RESOLVER FAILED'));
    expect(line, 'no RESOLVER FAILED line was logged for a thrown resolver').toBeTruthy();
    expect(line).toContain(PLAYER);
    expect(line).toContain('content_mode');
  });

  it('passes a real scope through untouched, with nothing logged', async () => {
    resolverMock.mockResolvedValue({ serverId: 'srv-1', mode: 'replace' });
    const scope = await currentContentScope(PLAYER);
    expect(scope).toEqual({ serverId: 'srv-1', mode: 'replace' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('treats "legitimately no scope" as an answer, not a fault — no log', async () => {
    resolverMock.mockResolvedValue({ serverId: null, mode: 'extend' });
    const scope = await currentContentScope(PLAYER);
    expect(scope).toEqual({ serverId: null, mode: 'extend' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('currentServer inherits both halves, because it delegates', async () => {
    resolverMock.mockRejectedValue(new Error('connection refused'));
    expect(await currentServer(PLAYER)).toBeNull();
    expect(
      errorSpy.mock.calls.some((c: unknown[]) => c.map(String).join(' ').includes('RESOLVER FAILED'))
    ).toBe(true);
  });
});

describe('the resolver ensures the schema it reads (source pin)', () => {
  it('customServers.currentContentScope runs its own ensure before its first read', async () => {
    /* The `server_id` production lesson, applied to `content_mode`: the
     * resolver reads columns that were ADDED to live tables, so it must not
     * depend on some other module having ensured them first. Source-pinned
     * (the modules are mocked above, so behaviour cannot be) — the ensure call
     * must appear in the function body BEFORE the selection read. */
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'customServers.ts'), 'utf8').replace(/\r\n/g, '\n');

    const at = src.indexOf('export async function currentContentScope');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('export async function', at + 10));
    const ensureAt = body.indexOf('await ensureCustomServerSchema(db)');
    const readAt = body.indexOf('SELECT server_id FROM player_server_selection');
    expect(ensureAt, 'the resolver no longer ensures its own schema').toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(-1);
    expect(ensureAt, 'the ensure must come BEFORE the read it protects').toBeLessThan(readAt);
  });
});
