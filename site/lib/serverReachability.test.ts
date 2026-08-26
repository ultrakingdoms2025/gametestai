import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  nextMemberState,
  ensureCustomServerSchema,
  createServer,
  applyMembershipAction,
  listJoinableServers,
  listServersForPlayer,
  canUseServer,
  selectServer,
  currentServerId,
} from './customServers';
import { writeEntitlement } from './premium';

/**
 * Two things that existed and could not be reached.
 *
 * ── 1. An invitation nobody could accept ──────────────────────────────────
 *
 * The accept verb shipped: `request` on an `invited` row lands on `approved`.
 * The only control that fired it was the "ask to join" list, fed by
 * `listJoinableServers`, which excludes any server the player already has a
 * non-removed row in — and an `invited` row is exactly that. So an invitation
 * REMOVED the server from the only list it could have been answered from, and
 * left the player a line of inert text. The owner waited on the player; the
 * player was told they were waiting on the owner.
 *
 * The fix is a button, not a widened exclusion, and this file pins both halves:
 * the invited player can now move, and a `requested` or `removed` player still
 * cannot skip a step.
 *
 * ── 2. A product linked from nowhere ──────────────────────────────────────
 *
 * `/admin/servers` is the whole custom-server product and the only recurring
 * SKU this project sells. Nothing on the site linked to it. A page that only
 * exists at a URL you already know is not shipped, it is hidden — the same
 * "complete, correct and unreachable" failure the lore defect was.
 *
 * Link assertions are textual because a Next page cannot be rendered under
 * vitest's node environment, and the claim is textual anyway: either the href
 * is in the markup or the customer cannot click it. Each is paired with an
 * assertion that the target page actually exists, so a link to a route that was
 * later moved fails here rather than in a customer's browser.
 */

const here = dirname(fileURLToPath(import.meta.url));

function testUrl(): string | null {
  if (process.env.POSTGRES_TEST_URL) return process.env.POSTGRES_TEST_URL;
  const envFile = join(here, '..', '.env.test.local');
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('POSTGRES_TEST_URL='));
  if (!line) return null;
  return line.slice('POSTGRES_TEST_URL='.length).trim().replace(/^["']|["']$/g, '');
}

const URL_ = testUrl();
const suite = URL_ ? describe : describe.skip;

/** CRLF-normalised: `core.autocrlf` is true in this repository. */
function source(...parts: string[]): string {
  return readFileSync(join(here, '..', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/* ---------------------------------------------------------------------- */
/* The accept control                                                      */
/* ---------------------------------------------------------------------- */

describe('the start panel gives an invited player something to press', () => {
  /* The panel became a two-step launch modal fed by the server directory, so
   * the anchors moved — the GUARANTEES did not. Each test below is the same
   * claim it was against the old markup: an invited player has a button, the
   * button fires the verb that already exists, an invitation is never a
   * sentence, and a suspended server is never a door. */
  const panel = source('components', 'ServerStartPanel.tsx');

  it('renders a control for memberships in the invited state', () => {
    /* A BUTTON inside the invited branch, not a status line. */
    expect(panel).toMatch(/callerState === 'invited'[\s\S]{0,240}<button/);
    expect(panel).toContain('Accept invitation');
  });

  it('and that control fires the verb that already exists', () => {
    /* Not a new endpoint and not a new action name. `request` on an `invited`
     * row is the accept, and `/api/game/server` already refuses a player acting
     * on anybody but themselves. */
    expect(panel).toContain("action: 'request', serverId: row.id");
  });

  it('does not leave the invitation in the inert "waiting on" line', () => {
    /* The regression to catch is the invited state collapsing into the same
     * "pending" prose the requested state gets — a sentence where a button
     * should be. Only `requested` may read as waiting. */
    expect(panel).toContain('Request pending');
    expect(panel).not.toMatch(/callerState === 'invited'[\s\S]{0,240}Request pending/);
    expect(panel).not.toMatch(/Waiting on/);
  });

  it('does not offer to join a suspended server', () => {
    /* The transition would succeed and `selectServer` would then refuse the
     * entry: a button that appears to work and does not. The refusal moved
     * upstream: the directory the panel renders NEVER CONTAINS a suspended
     * server (`listServersDirectory` filters on status = 'active';
     * serverDirectory.test.ts proves it against Postgres), so there is no row
     * for any state's button to appear on. */
    const lib = source('lib', 'customServers.ts');
    const fnAt = lib.indexOf('export async function listServersDirectory');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = lib.slice(fnAt, lib.indexOf('\n}', fnAt));
    expect(fn.replace(/\s+/g, ' ')).toContain("WHERE s.status = 'active'");
  });
});

describe('the exclusion that hid the invitation was NOT weakened', () => {
  it('listJoinableServers still skips every non-removed membership', () => {
    /* Widening this is the tempting fix and the wrong one: it would also put a
     * `requested` player's own pending server back in front of them, and let a
     * `removed` player press a button that reads as re-entry. */
    const src = source('lib', 'customServers.ts');
    expect(src.replace(/\s+/g, ' ')).toContain(
      "WHERE m.server_id = s.id AND m.player_id = $1 AND m.state <> 'removed'"
    );
  });

  it('and the state machine still makes a removed player ask again', () => {
    expect(nextMemberState('request', 'invited')).toBe('approved');
    // A re-ask is a no-op, not an escalation.
    expect(nextMemberState('request', 'requested')).toBe('requested');
    // Ejected means ejected: back to the queue, never straight back in.
    expect(nextMemberState('request', 'removed')).toBe('requested');
    // And an approved member cannot re-run the verb for anything.
    expect(nextMemberState('request', 'approved')).toBeNull();
  });
});

/* ---------------------------------------------------------------------- */
/* The product's front door                                                */
/* ---------------------------------------------------------------------- */

describe('the custom-server dashboard is reachable without typing its URL', () => {
  it('the page it links to exists', () => {
    expect(existsSync(join(here, '..', 'app', 'admin', 'servers', 'page.tsx'))).toBe(true);
  });

  it('from the persistent site header, for a signed-in visitor', () => {
    const header = source('components', 'SiteHeader.tsx');
    expect(header).toContain('href="/admin/servers"');
    /* Inside the authenticated branch: the page redirects a signed-out visitor
     * to the login screen, and a link whose only outcome is a login bounce is
     * not navigation. `status === 'authenticated'` opens that branch, and the
     * link must come after it. */
    const authAt = header.indexOf("status === 'authenticated'");
    expect(authAt).toBeGreaterThan(-1);
    expect(header.indexOf('href="/admin/servers"')).toBeGreaterThan(authAt);
  });

  it('from the home page dashboard, which is the one page the header hides', () => {
    const dash = source('components', 'AccountDashboard.tsx');
    expect(dash).toContain('href="/admin/servers"');
  });

  it('from the account page, closing the round trip that only went one way', () => {
    const account = source('app', 'account', 'page.tsx');
    expect(account).toContain('href="/admin/servers"');
    // The dashboard's own "Back to your account" is the other half.
    expect(source('app', 'admin', 'servers', 'page.tsx')).toContain('href="/account"');
  });

  it('and from the store, which is where a customer looks for what is for sale', () => {
    const store = source('app', 'store', 'page.tsx');
    expect(store).toContain('href="/admin/servers"');
    // It has to say what the product IS, not just link to a dashboard.
    expect(store).toMatch(/Host a custom server/i);
  });

  it('the store entry point describes the product and starts no checkout of its own', () => {
    /* The hosting SKU answers 503 without Stripe and has no simulated fallback,
     * deliberately. A "Subscribe" button here would land a customer on that 503
     * from a page that never explained what they were buying; the subscribe
     * control stays on the dashboard, beside the entitlement it grants. */
    const store = source('app', 'store', 'page.tsx');
    expect(store).not.toContain('/api/checkout');
    expect(store).not.toContain('server_hosting_monthly');
    // And when Stripe is absent the page says so rather than implying a sale.
    expect(store).toContain('stripeConfigured()');
  });
});

/* ---------------------------------------------------------------------- */
/* The journey, end to end                                                 */
/* ---------------------------------------------------------------------- */

const OWNER = 'reach-owner';
const GUEST = 'reach-guest';
const PLAYERS = [OWNER, GUEST];

suite('an invited player can actually get in (integration)', () => {
  let db: Client;
  let serverId: string;

  beforeAll(async () => {
    db = new Client({ connectionString: URL_!, ssl: { rejectUnauthorized: false } });
    await db.connect();
    const which = await db.query('SELECT current_database() AS db');
    if (which.rows[0].db !== 'aether_test') {
      throw new Error(`refusing to run against "${which.rows[0].db}" — expected aether_test`);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, handle TEXT, credit_balance INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const id of PLAYERS) {
      await db.query(
        `INSERT INTO players (id, handle, credit_balance) VALUES ($1, $2, 0)
         ON CONFLICT (id) DO NOTHING`,
        [id, `rc-${id.slice(-5)}`]
      );
    }
    await ensureCustomServerSchema(db);
  });

  const wipe = async () => {
    await db.query(`DELETE FROM player_server_selection WHERE player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM custom_servers WHERE owner_player_id = ANY($1::text[])`, [PLAYERS]);
    await db.query(`DELETE FROM server_entitlements WHERE player_id = ANY($1::text[])`, [PLAYERS]);
  };

  beforeEach(async () => {
    await wipe();
    await writeEntitlement(db, {
      playerId: OWNER, subscriptionId: 'sub_reach_test', customerId: 'cus_reach_test',
      status: 'active', currentPeriodEnd: null,
    });
    const made = await createServer(db, OWNER, { name: 'Reachable Keep' });
    if (!made.ok) throw new Error(`fixture server refused: ${made.reason}`);
    serverId = made.server.id;
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.end();
  });

  it('an invitation takes the server OUT of the ask-to-join list — the trap, still there', async () => {
    /* Reproduced rather than assumed, because it is the reason the button had
     * to exist and it is the thing a future "tidy up the panel" would undo. */
    expect((await listJoinableServers(db, GUEST)).map((s) => s.id)).toContain(serverId);

    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'invite',
    });

    expect((await listJoinableServers(db, GUEST)).map((s) => s.id)).not.toContain(serverId);
    // It IS in the panel's other list, which is what the Accept button reads.
    const mine = await listServersForPlayer(db, GUEST);
    expect(mine.find((m) => m.id === serverId)?.state).toBe('invited');
    expect(mine.find((m) => m.id === serverId)?.status).toBe('active');
  });

  it('and the Accept button\'s verb takes them all the way in', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'invite',
    });
    expect(await canUseServer(db, serverId, GUEST)).toBe(false);

    /* Exactly what `/api/game/server` does for `action: 'request'`: the caller
     * is passed as both actor and subject, so the route cannot even express
     * acting on somebody else. */
    const accepted = await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: GUEST, action: 'request',
    });
    expect(accepted).toEqual({ ok: true, state: 'approved', changed: true });
    expect(await canUseServer(db, serverId, GUEST)).toBe(true);

    // And the panel can then select it, which is the point of joining.
    const chosen = await selectServer(db, GUEST, serverId);
    expect(chosen).toEqual({ serverId, refused: false });
    expect(await currentServerId(db, GUEST)).toBe(serverId);
  });

  it('but a player who was never invited still only reaches "requested"', async () => {
    const asked = await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: GUEST, action: 'request',
    });
    expect(asked).toEqual({ ok: true, state: 'requested', changed: true });
    expect(await canUseServer(db, serverId, GUEST)).toBe(false);
    // Pressing again does not escalate.
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: GUEST, action: 'request',
    });
    expect(await canUseServer(db, serverId, GUEST)).toBe(false);
  });

  it('and a removed player cannot use the same verb to walk back in', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'invite',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: GUEST, action: 'request',
    });
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'remove',
    });

    const retry = await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: GUEST, action: 'request',
    });
    expect(retry).toEqual({ ok: true, state: 'requested', changed: true });
    expect(await canUseServer(db, serverId, GUEST)).toBe(false);
  });

  it('and nobody can accept an invitation on somebody else\'s behalf', async () => {
    await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'invite',
    });
    const forged = await applyMembershipAction(db, {
      serverId, subjectPlayerId: GUEST, actorPlayerId: OWNER, action: 'request',
    });
    expect(forged).toEqual({ ok: false, reason: 'forbidden' });
  });
});
