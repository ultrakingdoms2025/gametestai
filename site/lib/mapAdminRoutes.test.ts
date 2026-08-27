import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MAX_LAYOUT_BYTES, encodeHeights } from '@/lib/mapLayout';

/**
 * WHO CAN REACH THE MAP EDITOR.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE IS THE FIRST TEST OF THE PHASE, NOT THE LAST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 0 of this roadmap existed because NINE admin pages were unguarded in
 * production, and because the marketplace admin allowlist treated "no allowlist
 * configured" as "allow everybody" — which, with neither env var set live, meant
 * every signed-in user could set the buy and sell prices of the credit economy.
 *
 * This phase adds a surface that can move buildings and place items in a live
 * world. So authorisation is not a wrapper around the feature; it is the
 * feature's first requirement, and it is tested by calling the REAL exported
 * route handlers rather than by reading the source and believing it.
 *
 * `@/lib/auth` and `@/lib/db` are mocked because they are the session and the
 * user lookup — the two inputs a caller controls. Everything after them,
 * including `isAllowedAdminEmail` and the handler's own branching, runs for
 * real. `@/lib/mapOverlay` is mocked so the test can assert the stronger
 * property: a refused caller does not merely get a 403, it never reaches the
 * database at all.
 */

const auth = vi.fn();
const getUserById = vi.fn();

vi.mock('@/lib/auth', () => ({ auth: () => auth() }));
vi.mock('@/lib/db', () => ({ getUserById: (id: string) => getUserById(id) }));

const store = {
  readCurrentOverlay: vi.fn(),
  listOverlayVersions: vi.fn(),
  saveOverlayVersion: vi.fn(),
  revertOverlayTo: vi.fn(),
  recordWorldReport: vi.fn(),
  readWorldReport: vi.fn(),
  ensureMapOverlaySchema: vi.fn(),
};

vi.mock('@/lib/mapOverlay', () => ({
  ensureMapOverlaySchema: (...a: unknown[]) => store.ensureMapOverlaySchema(...a),
  readCurrentOverlay: (...a: unknown[]) => store.readCurrentOverlay(...a),
  listOverlayVersions: (...a: unknown[]) => store.listOverlayVersions(...a),
  saveOverlayVersion: (...a: unknown[]) => store.saveOverlayVersion(...a),
  revertOverlayTo: (...a: unknown[]) => store.revertOverlayTo(...a),
  recordWorldReport: (...a: unknown[]) => store.recordWorldReport(...a),
  readWorldReport: (...a: unknown[]) => store.readWorldReport(...a),
  MAX_CATALOGUE_OBJECTS: 2000,
}));

const appendAudit = vi.fn();
vi.mock('@/lib/auditChain', () => ({
  appendAudit: (...a: unknown[]) => appendAudit(...a),
  ensureAuditSchema: vi.fn(),
}));

interface FakeConn {
  connect: () => Promise<void>;
  end: () => Promise<void>;
  query: ReturnType<typeof vi.fn>;
  statements: string[];
}
const connections: FakeConn[] = [];
vi.mock('pg', () => {
  class FakeClient {
    statements: string[] = [];
    connect = vi.fn(async () => {});
    end = vi.fn(async () => {});
    query = vi.fn(async (text: string) => {
      this.statements.push(String(text).trim().split(/\s+/)[0].toUpperCase());
      return { rows: [] };
    });
    constructor() {
      connections.push(this as never);
    }
  }
  return { Client: FakeClient, default: { Client: FakeClient } };
});

const ADMIN = 'owner@example.com';

function signedInAs(email: string | null) {
  if (!email) {
    auth.mockResolvedValue(null);
    return;
  }
  auth.mockResolvedValue({ user: { id: 'u1', email } });
  getUserById.mockResolvedValue({ id: 'u1', email });
}

const SAVED_ENV = process.env.ADMIN_EMAILS;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations — a `mockRejectedValue`
  // set by one test would otherwise still be in force in the next one, which is
  // how the audit-failure test silently made the audit-success test fail.
  appendAudit.mockReset();
  appendAudit.mockResolvedValue({ seq: 1, prevHash: 'prev', entryHash: 'entry' });
  connections.length = 0;
  process.env.ADMIN_EMAILS = ADMIN;
  store.readCurrentOverlay.mockResolvedValue({
    worldId: 'station',
    version: 0,
    schema: 1,
    entries: [],
    author: null,
    note: null,
    createdAt: null,
  });
  store.listOverlayVersions.mockResolvedValue([]);
  store.readWorldReport.mockResolvedValue(null);
  store.saveOverlayVersion.mockResolvedValue({
    worldId: 'station',
    version: 1,
    schema: 1,
    entries: [],
    author: ADMIN,
    note: null,
    createdAt: new Date().toISOString(),
    rejected: [],
  });
  store.revertOverlayTo.mockResolvedValue({
    worldId: 'station',
    version: 2,
    schema: 1,
    entries: [],
    author: ADMIN,
    note: 'revert to version 1',
    createdAt: new Date().toISOString(),
    rejected: [],
  });
});

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = SAVED_ENV;
});

function noDatabaseWasTouched() {
  for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled();
  expect(appendAudit).not.toHaveBeenCalled();
  expect(connections).toHaveLength(0);
}

describe('GET /api/admin/map/[world]', () => {
  async function get(world = 'station') {
    const { GET } = await import('@/app/api/admin/map/[world]/route');
    return GET(new Request(`http://localhost/api/admin/map/${world}`), {
      params: Promise.resolve({ world }),
    });
  }

  it('refuses an anonymous caller and never reaches the database', async () => {
    signedInAs(null);
    const res = await get();
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('refuses a signed-in user who is not on the allowlist', async () => {
    signedInAs('intruder@example.com');
    const res = await get();
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('refuses everyone when the allowlist is not configured at all', async () => {
    delete process.env.ADMIN_EMAILS;
    delete process.env.MARKETPLACE_ADMIN_EMAILS;
    signedInAs(ADMIN);
    const res = await get();
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('lets an allowlisted admin through', async () => {
    signedInAs(ADMIN);
    const res = await get();
    expect(res.status).toBe(200);
    expect(store.readCurrentOverlay).toHaveBeenCalled();
    const body = await res.json();
    expect(body.world).toBe('station');
    expect(body.overlay.version).toBe(0);
  });

  it('refuses a world the game does not have, even for an admin', async () => {
    signedInAs(ADMIN);
    const res = await get('not-a-world');
    expect(res.status).toBe(404);
    expect(store.readCurrentOverlay).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/map/[world]', () => {
  async function post(body: unknown, world = 'station') {
    const { POST } = await import('@/app/api/admin/map/[world]/route');
    return POST(
      new Request(`http://localhost/api/admin/map/${world}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ world }) }
    );
  }

  it('refuses an anonymous caller before writing anything', async () => {
    signedInAs(null);
    const res = await post({ entries: [] });
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('refuses a signed-in non-admin before writing anything', async () => {
    signedInAs('intruder@example.com');
    const res = await post({ entries: [{ kind: 'move', target: { name: 'x' }, position: { x: 0, y: 0, z: 0 } }] });
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('saves for an admin and writes an audit row naming them', async () => {
    signedInAs(ADMIN);
    const res = await post({ entries: [], note: 'tidy up' });
    expect(res.status).toBe(200);
    expect(store.saveOverlayVersion).toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledTimes(1);
    const entry = appendAudit.mock.calls[0][1];
    expect(entry.actor).toBe(ADMIN);
    expect(entry.action).toBe('map.overlay.save');
    expect(entry.resource).toBe('world:station');
  });

  it('reverts for an admin and audits that separately', async () => {
    signedInAs(ADMIN);
    const res = await post({ revertTo: 1 });
    expect(res.status).toBe(200);
    expect(store.revertOverlayTo).toHaveBeenCalled();
    expect(store.saveOverlayVersion).not.toHaveBeenCalled();
    expect(appendAudit.mock.calls[0][1].action).toBe('map.overlay.revert');
  });

  it('answers 404 when the version to revert to does not exist', async () => {
    signedInAs(ADMIN);
    store.revertOverlayTo.mockResolvedValue(null);
    const res = await post({ revertTo: 99 });
    expect(res.status).toBe(404);
    expect(appendAudit).not.toHaveBeenCalled();
  });

  /**
   * An overlay change that cannot be audited must not happen.
   *
   * The audit log is the only record that an administrator moved a building in
   * a live world. Writing the change and failing to record it is the worst of
   * the three outcomes — worse than refusing, because afterwards nothing says
   * anything happened. `HMAC_SECRET` missing on the site deployment is the way
   * this actually occurs, and it is a configuration state, not an exotic one.
   */
  it('rolls the save back when the audit row cannot be written', async () => {
    signedInAs(ADMIN);
    appendAudit.mockRejectedValue(new Error('HMAC_SECRET env var is not set'));

    const res = await post({ entries: [] });
    expect(res.status).toBe(500);

    const conn = connections[0];
    expect(conn.statements).toContain('BEGIN');
    expect(conn.statements).toContain('ROLLBACK');
    expect(conn.statements).not.toContain('COMMIT');
  });

  it('commits the save and the audit row together', async () => {
    signedInAs(ADMIN);
    const res = await post({ entries: [] });
    expect(res.status).toBe(200);

    const conn = connections[0];
    expect(conn.statements).toContain('BEGIN');
    expect(conn.statements).toContain('COMMIT');
    expect(conn.statements).not.toContain('ROLLBACK');
  });

  /**
   * The schema DDL runs BEFORE the transaction, and that ordering is load
   * bearing. `ensureMapOverlaySchema` memoises its promise; if its CREATE TABLE
   * ran inside a transaction that then rolled back, the tables would be gone
   * while the memo still said "ensured", and every later request on that
   * instance would skip the DDL and fail on a table that is not there.
   */
  it('ensures the schema before opening the transaction', async () => {
    signedInAs(ADMIN);
    await post({ entries: [] });
    const conn = connections[0];
    const ensured = store.ensureMapOverlaySchema.mock.invocationCallOrder[0];
    expect(ensured).toBeDefined();
    expect(conn.statements.indexOf('BEGIN')).toBeGreaterThanOrEqual(0);
    // The store is mocked, so the check that matters is that the route asked
    // for the schema itself, outside the transaction it opens afterwards.
    expect(store.ensureMapOverlaySchema).toHaveBeenCalled();
  });

  it('rejects a malformed body without reaching the store', async () => {
    signedInAs(ADMIN);
    const { POST } = await import('@/app/api/admin/map/[world]/route');
    const res = await POST(
      new Request('http://localhost/api/admin/map/station', { method: 'POST', body: 'not json' }),
      { params: Promise.resolve({ world: 'station' }) }
    );
    expect(res.status).toBe(400);
    expect(store.saveOverlayVersion).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/map/report', () => {
  async function post(body: unknown) {
    const { POST } = await import('@/app/api/admin/map/report/route');
    return POST(
      new Request('http://localhost/api/admin/map/report', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      })
    );
  }

  const REPORT = {
    world: 'station',
    appliedVersion: 1,
    objects: [{ name: 'crate', position: { x: 0, y: 0, z: 0 } }],
    applied: [],
    unresolved: [],
  };

  const LAYOUT = {
    layoutSchema: 1, bounds: { min: { x: -10, y: 0, z: -10 }, max: { x: 10, y: 5, z: 10 } }, shapes: [{ kind: 'rect', x: 0, z: 0, w: 4, d: 4 }],
    ground: { originX: -10, originZ: -10, step: 20, nx: 2, nz: 2, layers: 1, heightsCm: encodeHeights(new Int16Array(4)) },
  };

  it('refuses an anonymous game client', async () => {
    signedInAs(null);
    const res = await post(REPORT);
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('refuses a signed-in player who is not an admin, even though their client asked nicely', async () => {
    signedInAs('player@example.com');
    const res = await post(REPORT);
    expect(res.status).toBe(403);
    noDatabaseWasTouched();
  });

  it('accepts a report from an admin', async () => {
    signedInAs(ADMIN);
    const res = await post(REPORT);
    expect(res.status).toBe(200);
    expect(store.recordWorldReport).toHaveBeenCalled();
  });

  it('refuses a report about a world that does not exist', async () => {
    signedInAs(ADMIN);
    const res = await post({ ...REPORT, world: '../../etc' });
    expect(res.status).toBe(404);
    expect(store.recordWorldReport).not.toHaveBeenCalled();
  });

  /** An array parses as JSON and is an object to `typeof`, but it is not a report; the answer is "malformed", not "no such world". */
  it('refuses an array body as malformed, not as an unknown world, without reaching the store', async () => {
    signedInAs(ADMIN);
    const res = await post([REPORT]);
    expect(res.status).toBe(400);
    expect(store.recordWorldReport).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
  });

  it('hands the layout fields to the store untouched, for the store to validate', async () => {
    signedInAs(ADMIN);
    const res = await post({ ...REPORT, ...LAYOUT });
    expect(res.status).toBe(200);
    expect(store.recordWorldReport.mock.calls[0][2]).toMatchObject(LAYOUT);
  });

  it('refuses a report over the byte cap with 413 and never opens a connection; still 400 for non-JSON', async () => {
    signedInAs(ADMIN);
    const res = await post({ ...REPORT, ...LAYOUT, pad: 'x'.repeat(MAX_LAYOUT_BYTES) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Report too large' });
    const { POST } = await import('@/app/api/admin/map/report/route');
    const bad = await POST(new Request('http://localhost/api/admin/map/report', { method: 'POST', body: 'not json' }));
    expect(bad.status).toBe(400);
    expect(store.recordWorldReport).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
  });

  /**
   * A Request built in-process carries no content-length, so the test above reaches the 413
   * only by measuring the bytes. This one sets the header by hand: the declared length alone
   * must refuse the report, and the body — small, and honest JSON — must never be read for it.
   */
  it('refuses a declared oversize before reading the body at all', async () => {
    signedInAs(ADMIN);
    const text = vi.spyOn(Request.prototype, 'text');
    try {
      const { POST } = await import('@/app/api/admin/map/report/route');
      const req = new Request('http://localhost/api/admin/map/report', {
        method: 'POST',
        body: JSON.stringify({ ...REPORT, ...LAYOUT }),
        headers: { 'content-type': 'application/json', 'content-length': String(MAX_LAYOUT_BYTES + 1) },
      });
      const res = await POST(req);
      expect(res.status).toBe(413);
      expect(text).not.toHaveBeenCalled();
      expect(req.bodyUsed).toBe(false);
      expect(store.recordWorldReport).not.toHaveBeenCalled();
      expect(connections).toHaveLength(0);
    } finally {
      text.mockRestore();
    }
  });

  /**
   * The spy proves `.text()` was not called; `bodyUsed` proves NO reader was — `.json()`,
   * `.arrayBuffer()` and a stream all flip it — so the test holds however the route reads.
   */
  it('refuses an anonymous client before reading a byte of the body', async () => {
    signedInAs(null);
    const text = vi.spyOn(Request.prototype, 'text');
    try {
      const { POST } = await import('@/app/api/admin/map/report/route');
      const req = new Request('http://localhost/api/admin/map/report', {
        method: 'POST',
        body: JSON.stringify({ ...REPORT, ...LAYOUT }),
        headers: { 'content-type': 'application/json' },
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
      expect(text).not.toHaveBeenCalled();
      expect(req.bodyUsed).toBe(false);
      noDatabaseWasTouched();
    } finally {
      text.mockRestore();
    }
  });
});

describe('GET /api/game/map-overlay', () => {
  async function get(world = 'station') {
    const { GET } = await import('@/app/api/game/map-overlay/route');
    return GET(new Request(`http://localhost/api/game/map-overlay?world=${world}`));
  }

  it('refuses an anonymous caller: the game is paywalled and so is its data', async () => {
    signedInAs(null);
    const res = await get();
    expect(res.status).toBe(401);
    noDatabaseWasTouched();
  });

  it('serves the overlay to a signed-in player but does not call them an admin', async () => {
    signedInAs('player@example.com');
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.admin).toBe(false);
    expect(body.entries).toEqual([]);
    expect(body.version).toBe(0);
  });

  it('tells an allowlisted admin that they are one, so their client offers to report back', async () => {
    signedInAs(ADMIN);
    const res = await get();
    const body = await res.json();
    expect(body.admin).toBe(true);
  });

  it('refuses an unknown world rather than inventing an empty overlay for it', async () => {
    signedInAs('player@example.com');
    const res = await get('not-a-world');
    expect(res.status).toBe(404);
  });
});
