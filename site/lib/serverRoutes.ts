import { Client } from 'pg';
import { auth } from './auth';
import { getUserById } from './db';
import { findOrCreatePlayer } from './playerDb';
import { isAllowedAdminEmail } from './adminAllowlist';
import { ensureCustomServerSchema, getServer, type CustomServer } from './customServers';
import { appendAudit } from './auditChain';

/**
 * The plumbing every custom-server route needs, in one place.
 *
 * ── Why the authorisation lives here and not in each route ────────────────
 *
 * There are seven routes in this phase and three questions between them: who is
 * calling, do they own this server, and are they a platform admin. Answered in
 * each route, that is three rules with seven implementations, and the one that
 * drifts is the one nobody re-reads. `adminAccess.ts` makes the same argument
 * about the marketplace allowlist and it was right.
 *
 * ── Fails closed, in the same two ways `adminAllowlist` does ──────────────
 *
 * No session is not an actor. An unconfigured `ADMIN_EMAILS` is not a platform
 * admin — that default used to GRANT, and it was the live branch in production.
 * `isAllowedAdminEmail` already refuses an empty allowlist; this file just does
 * not add a second opinion.
 */

export function makeClient(): Client {
  const connStr = process.env.POSTGRES_URL ?? '';
  const ssl = connStr.includes('sslmode=disable') ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: connStr, ssl });
}

export interface Actor {
  playerId: string;
  email: string;
  /** A platform admin, per the same allowlist the marketplace admin uses. */
  platformAdmin: boolean;
}

/**
 * Who is calling, or null when nobody is.
 *
 * Opens no database connection of its own beyond the ones `findOrCreatePlayer`
 * already makes, because every caller is about to open one anyway.
 */
export async function resolveActor(): Promise<Actor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await getUserById(session.user.id);
  if (!user) return null;
  const playerId = await findOrCreatePlayer(session.user.id, user.email);
  return {
    playerId,
    email: user.email,
    platformAdmin: isAllowedAdminEmail(user.email),
  };
}

export type ServerAccess =
  | { ok: true; server: CustomServer; isOwner: boolean }
  | { ok: false; status: 403 | 404 };

/**
 * The server this actor is administering, if they may.
 *
 * A platform admin passes for any server; anyone else only for their own. A
 * server that does not exist and a server that is not yours both answer 404 —
 * a 403 would confirm the id exists, which turns any of these routes into a way
 * to enumerate other people's servers.
 */
export async function requireOwnedServer(
  db: Client,
  actor: Actor,
  serverId: string
): Promise<ServerAccess> {
  const server = await getServer(db, serverId);
  if (!server) return { ok: false, status: 404 };
  const isOwner = server.ownerPlayerId === actor.playerId;
  if (!isOwner && !actor.platformAdmin) return { ok: false, status: 404 };
  return { ok: true, server, isOwner };
}

/**
 * Open a connection with the custom-server schema ensured.
 *
 * Callers must `end()` it. Written as a helper rather than repeated because
 * forgetting `ensureCustomServerSchema` is a route that works on a warm database
 * and 500s on a cold one, which is the worst kind of intermittent.
 */
export async function openServerDb(): Promise<Client> {
  const db = makeClient();
  await db.connect();
  try {
    await ensureCustomServerSchema(db);
    return db;
  } catch (err) {
    await db.end().catch(() => {});
    throw err;
  }
}

/**
 * The server this player is in, opening and closing its own connection.
 *
 * For the routes that predate this phase — the quest list, the marketplace —
 * which reach the database through per-call `query()` helpers and have no
 * connection to borrow. One extra round trip on those paths, in exchange for not
 * restructuring three shipped route handlers to thread a client through.
 *
 * Returns null on ANY failure, which is the safe direction: null is the platform
 * partition, so a database hiccup shows a player the default catalogue rather
 * than failing their request or, worse, showing them somebody else's.
 */
export async function currentServer(playerId: string): Promise<string | null> {
  let db: Client | null = null;
  try {
    db = await openServerDb();
    const { currentServerId } = await import('./customServers');
    return await currentServerId(db, playerId);
  } catch (err) {
    console.error('[servers] could not resolve the current server:', err);
    return null;
  } finally {
    await db?.end().catch(() => {});
  }
}

/**
 * Record an administrative act in the HMAC-chained audit log.
 *
 * `auditChain.appendAudit`, not `admin/lib/db.ts`'s version: that one hashes
 * `MAX(seq) + 1` and lets BIGSERIAL assign the real one, and those two agree
 * only until something consumes a sequence value without committing. One
 * rolled-back insert and every row after it is hashed against a seq it does not
 * have, after which the dashboard reports the log as tampered with forever.
 *
 * Never allowed to fail a request: an audit row is a record of something that
 * happened, and refusing the action because the record failed loses both.
 */
export async function auditServerAction(
  db: Client,
  actor: Actor,
  action: string,
  resource: string,
  detail?: unknown
): Promise<void> {
  try {
    await appendAudit(db, {
      actor: actor.email,
      action,
      resource,
      detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 4000),
    });
  } catch (err) {
    console.error('[servers] audit append failed:', err);
  }
}
