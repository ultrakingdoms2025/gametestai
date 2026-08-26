import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { ensureLeaderboardSchema } from './leaderboard';
import { entitlementPermitsHosting, readEntitlement } from './premium';

/**
 * Custom servers: per-owner content variants over the infrastructure that
 * already exists.
 *
 * ── What decision D2 bought, and what it therefore rules out ──────────────
 *
 * D2 is "per-owner content variants, with shared leaderboards". Players enter
 * INDIVIDUALLY: there is no shared live world instance, so there is no new
 * runtime here, no socket server and no state to synchronise. Every surface in
 * this phase — membership, chat, server credits — is HTTP against Postgres,
 * which is what keeps the whole thing on Vercel's serverless functions.
 *
 * The consequence worth stating plainly, because it will otherwise be
 * discovered by someone expecting otherwise: two members of the same custom
 * server standing in the same world do not see each other. They share a
 * catalogue, a ledger, a chat log and a leaderboard. They do not share a world.
 *
 * ── The abuse vector, and where this file sits in closing it ──────────────
 *
 * Owners author content AND leaderboards are shared, so left alone an owner
 * mints rank by authoring a one-step quest that pays 10,000 CR. `leaderboard.ts`
 * closes that by construction: a global board enumerates the platform content
 * manifest in its FROM clause, so a forged identity is not a candidate at all.
 * It recorded exactly one residual, and that residual is this phase's job:
 *
 *   > "A quest authored by an owner INTO A PLATFORM WORLD with `server_id` left
 *   > NULL is, by every column this table has, a platform quest. Phase 7c's
 *   > owner CRUD must stamp it."
 *
 * `serverContent.ts` is where that stamp is applied, and it is applied by
 * construction rather than by remembering: the owner-authoring functions take
 * the server id as a REQUIRED first-class argument and refuse an empty one, so
 * there is no call shape that writes NULL. See that file's header.
 *
 * ── Server credits cannot feed the global balance (7f) ────────────────────
 *
 * Not "must not" — cannot. `serverCredits.ts` writes `server_credit_balances`
 * and `server_credit_events`, two tables declared below that have no column
 * referring to `players.credit_balance` and no relationship to `credit_events`.
 * A leak would not be a missing filter, it would be a new function nobody has
 * written. `serverCredits.test.ts` asserts the module's source never names the
 * global tables, which is a cheap gate that measures the real thing.
 *
 * ── Why `lore_entries` gets a column but not the owner rows ───────────────
 *
 * `server_id` is added additively to `lore_entries` and `marketplace_items`
 * below, and every existing read path is scoped so a player with no server sees
 * exactly today's global content.
 *
 * Owner lore nonetheless lands in `server_lore_entries`, a separate table, and
 * the reason is a live deploy hazard rather than taste. `lore_entries.scope` is
 * a PRIMARY KEY, so two rows cannot share a scope, so per-server variants need
 * that key relaxed. Three live code paths in `admin/lib/db.ts` upsert with
 * `ON CONFLICT (scope)`, and Postgres resolves that against the unique index on
 * `scope` ALONE — relax the key and every one of them raises "no unique or
 * exclusion constraint matching the ON CONFLICT specification". The two apps
 * deploy independently, so there is no ordering of the two changes that does not
 * leave the lore admin broken for a window: site-first breaks the old admin
 * code, admin-first breaks against the old index.
 *
 * A separate table has no such window. The column stays because it is the same
 * argument `leaderboard.ts` makes for adding `server_id` before a writer exists:
 * the global read path states its scope NOW, while every row is still NULL, so
 * there is no later "and now add the filter" step to forget.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/* ---------------------------------------------------------------------- */
/* Membership, as a state machine                                          */
/* ---------------------------------------------------------------------- */

/**
 * The four states the roadmap names, and nothing else.
 *
 * `removed` is a state rather than a deleted row on purpose: a removed member
 * who asks again should be a `requested` row the owner already recognises, and
 * an owner who removed someone should be able to see that they did.
 */
export const MEMBER_STATES = Object.freeze([
  'invited',
  'requested',
  'approved',
  'removed',
] as const);

export type MemberState = (typeof MEMBER_STATES)[number];

/** Every action either side can take on a membership. */
export type MemberAction =
  | 'invite'   // owner offers
  | 'request'  // player asks
  | 'approve'  // owner admits — also how a player accepts their own invite
  | 'reject'   // owner declines a request or withdraws an invite
  | 'remove';  // owner ejects an approved member

/** Who is allowed to take an action. */
export type Actor = 'owner' | 'player';

export const ACTION_ACTOR: Readonly<Record<MemberAction, Actor>> = Object.freeze({
  invite: 'owner',
  request: 'player',
  approve: 'owner',
  reject: 'owner',
  remove: 'owner',
});

/**
 * The transition table. `null` for a state the action is not legal from.
 *
 * A table rather than a chain of `if`s because it is the whole of the rule and
 * it is worth being able to read it in one glance — and because the tests can
 * then enumerate it rather than sampling it.
 *
 * `null` as the "from" key means no row exists yet.
 */
type FromState = MemberState | 'none';

const TRANSITIONS: Readonly<Record<MemberAction, Readonly<Record<FromState, MemberState | null>>>> =
  Object.freeze({
    invite: Object.freeze({
      none: 'invited', invited: 'invited', requested: 'approved',
      approved: null, removed: 'invited',
    }),
    request: Object.freeze({
      none: 'requested', invited: 'approved', requested: 'requested',
      approved: null, removed: 'requested',
    }),
    approve: Object.freeze({
      none: null, invited: 'approved', requested: 'approved',
      approved: 'approved', removed: null,
    }),
    reject: Object.freeze({
      none: null, invited: 'removed', requested: 'removed',
      approved: null, removed: 'removed',
    }),
    remove: Object.freeze({
      none: null, invited: 'removed', requested: 'removed',
      approved: 'removed', removed: 'removed',
    }),
  });

/**
 * Where an action takes a membership, or null if it is not legal from here.
 *
 * Two entries are worth naming because they are the useful ones and they are
 * not obvious:
 *
 *   - `invite` on a `requested` row lands on `approved`. The owner has been
 *     asked and has answered by offering; making them then also press approve
 *     would be a second click for a decision already taken.
 *   - `request` on an `invited` row is how a player ACCEPTS an invitation. The
 *     player-side verb for "yes" is the same verb as "please" and the state the
 *     owner already set decides which it means.
 *
 * `approve` from `none` is null, and that matters: an owner cannot conjure a
 * member who has not asked and has not been invited. Adding someone to a server
 * without either is not membership, it is conscription.
 */
export function nextMemberState(
  action: MemberAction,
  from: MemberState | null
): MemberState | null {
  const table = TRANSITIONS[action];
  if (!table) return null;
  return table[from ?? 'none'] ?? null;
}

/** Membership that lets a player see and use a server's content. */
export function isActiveMember(state: MemberState | null): boolean {
  return state === 'approved';
}

/* ---------------------------------------------------------------------- */
/* Shapes                                                                  */
/* ---------------------------------------------------------------------- */

export interface CustomServer {
  id: string;
  ownerPlayerId: string;
  name: string;
  slug: string;
  description: string;
  /** `active` or `suspended`. A suspended server serves no content. */
  status: 'active' | 'suspended';
  createdAt: string;
}

export interface Membership {
  serverId: string;
  playerId: string;
  state: MemberState;
  handle: string | null;
  updatedAt: string;
}

export type CreateServerRefusal =
  | 'no_entitlement'
  | 'quota'
  | 'invalid_name'
  | 'slug_taken';

export type CreateServerOutcome =
  | { ok: true; server: CustomServer }
  | { ok: false; reason: CreateServerRefusal };

/* ---------------------------------------------------------------------- */
/* Schema                                                                  */
/* ---------------------------------------------------------------------- */

let schemaPromise: Promise<void> | null = null;

/**
 * Additive, idempotent, and safe to run repeatedly against production.
 *
 * The promise is memoised, not a boolean, so two concurrent lambdas wait for
 * the DDL rather than racing past it into a missing table; a rejection clears
 * the memo so a transient failure is not cached for the life of the process.
 * Memoising across connections is correct because the DDL is a property of the
 * DATABASE, not of the client that ran it.
 */
export function ensureCustomServerSchema(db: Db): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = runCustomServerSchema(db).catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** Test-only: forget the memo so a fresh database can be built again. */
export function resetCustomServerSchemaMemo(): void {
  schemaPromise = null;
}

async function runCustomServerSchema(db: Db): Promise<void> {
  /* `server_id` on the progress and quest tables, plus the boards that read
   * them. Already run by `leaderboard.ts`; called here so a deployment that
   * reaches a server route before a board route is not missing the columns the
   * content scoping depends on. Both are memoised, so the second call is free. */
  await ensureLeaderboardSchema(db);

  await db.query(`
    CREATE TABLE IF NOT EXISTS custom_servers (
      id              TEXT PRIMARY KEY,
      -- TEXT, not UUID, for the measured reason credit_events records:
      -- production's players.id is TEXT and Postgres refuses a UUID -> TEXT
      -- foreign key outright.
      owner_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      slug            TEXT NOT NULL UNIQUE,
      description     TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS custom_servers_owner_idx ON custom_servers (owner_player_id)`
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id  TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      state      TEXT NOT NULL,
      invited_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, player_id)
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS server_members_player_idx ON server_members (player_id, state)`
  );

  /* Which server a player is currently playing in. One row per player, so
   * "entered a server" is a single upsert and there is no session to expire.
   * NULL `server_id` is the default mode, stored rather than inferred so
   * choosing default mode is a positive act the server records. */
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_server_selection (
      player_id  TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      server_id  TEXT REFERENCES custom_servers(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /* ---- 7f: the server-scoped ledger --------------------------------- *
   * Two tables of its own. There is deliberately no column here that names
   * `players.credit_balance`, and nothing in `serverCredits.ts` writes it. */
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_credit_balances (
      server_id  TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      balance    INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, player_id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_credit_events (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id     TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      event_key     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      detail        TEXT,
      delta         INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The idempotency guarantee, scoped per server: the same key in two servers
  // is two different events, and the same key twice in one is one.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS server_credit_events_key_idx
      ON server_credit_events (server_id, player_id, event_key)
  `);

  /* ---- 7e: scoped chat ---------------------------------------------- */
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_chat_messages (
      id             BIGSERIAL PRIMARY KEY,
      server_id      TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      from_player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      -- NULL is a server-wide shout. A player id is a direct message.
      to_player_id   TEXT REFERENCES players(id) ON DELETE CASCADE,
      body           TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // Polling reads "everything in this server after id N", newest last.
  await db.query(`
    CREATE INDEX IF NOT EXISTS server_chat_scan_idx
      ON server_chat_messages (server_id, id)
  `);

  /* Who is currently in a server, so "selected active players" is answerable
   * without a socket. A heartbeat row, not a session. */
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_presence (
      server_id TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, player_id)
    )
  `);

  /* ---- 7a: owner content ------------------------------------------- */
  // Additive on the shared tables. Every existing read path is scoped to
  // `server_id IS NULL`, which is every row that exists today.
  await db
    .query(`ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS server_id TEXT`)
    .catch(() => {});
  await db
    .query(`ALTER TABLE lore_entries ADD COLUMN IF NOT EXISTS server_id TEXT`)
    .catch(() => {});
  await db
    .query(
      `CREATE INDEX IF NOT EXISTS marketplace_items_server_idx
         ON marketplace_items (server_id, is_active, sort_order, name)`
    )
    .catch(() => {});

  // Owner lore, in its own table. See the header for why not in `lore_entries`.
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_lore_entries (
      server_id  TEXT NOT NULL REFERENCES custom_servers(id) ON DELETE CASCADE,
      scope      TEXT NOT NULL,
      title      TEXT NOT NULL,
      sign_label TEXT NOT NULL DEFAULT 'Lorekeeper',
      body       TEXT NOT NULL,
      updated_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, scope)
    )
  `);

  /* ---- 7b: premium entitlement -------------------------------------- */
  await db.query(`
    CREATE TABLE IF NOT EXISTS server_entitlements (
      player_id              TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
      stripe_customer_id     TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status                 TEXT NOT NULL DEFAULT 'inactive',
      current_period_end     TIMESTAMPTZ,
      max_servers            INTEGER NOT NULL DEFAULT 1,
      simulated              BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  /* A hosting purchase made while Stripe is unconfigured writes a real,
   * working entitlement that nobody paid for. This column is how every one of
   * them is found and revoked the day real payments start — see the "Simulated
   * purchase" section of `premium.ts` for why it is a column AND an id prefix
   * rather than either alone.
   *
   * ALTER rather than only the CREATE above, because the table already exists
   * in production. Not `.catch(() => {})` like the optional back-fills further
   * up: `readEntitlement` selects this column, so a silently skipped migration
   * would turn every entitlement read into a 500 instead of failing here where
   * the message says what went wrong. */
  await db.query(
    `ALTER TABLE server_entitlements
       ADD COLUMN IF NOT EXISTS simulated BOOLEAN NOT NULL DEFAULT FALSE`
  );
  /* Webhook idempotency. Stripe redelivers, and a redelivered
   * `customer.subscription.deleted` arriving after a fresh subscription would
   * otherwise revoke an entitlement that was just paid for. */
  await db.query(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id    TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/* ---------------------------------------------------------------------- */
/* Naming                                                                  */
/* ---------------------------------------------------------------------- */

export const SERVER_NAME_MAX = 48;
const SLUG_MAX = 40;

/**
 * A url-safe slug for a server name, or '' if the name yields nothing usable.
 *
 * Returning '' rather than a fallback like 'server' is deliberate: a name of
 * pure punctuation is an authoring mistake, and inventing a slug for it hides
 * the mistake behind a row nobody meant to create.
 */
export function slugify(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    /* NFKD splits an accented letter into a base letter and a combining mark;
     * `\p{M}` then DROPS the mark. Dropping is what matters and it is easy to
     * leave out: without it the mark is simply a character outside [a-z0-9], so
     * it becomes a hyphen and "Ünïcödé" slugs as "u-ni-co-de". Caught by a
     * test, not by reading. */
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function cleanServerName(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SERVER_NAME_MAX);
}

/* ---------------------------------------------------------------------- */
/* Servers                                                                 */
/* ---------------------------------------------------------------------- */

interface ServerRow {
  id: string;
  owner_player_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  created_at: string;
}

function toServer(row: ServerRow): CustomServer {
  return {
    id: String(row.id),
    ownerPlayerId: String(row.owner_player_id),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    description: String(row.description ?? ''),
    status: row.status === 'suspended' ? 'suspended' : 'active',
    createdAt: String(row.created_at ?? ''),
  };
}

const SERVER_COLS =
  'id, owner_player_id, name, slug, description, status, created_at';

/**
 * Create a server, if the owner has paid for one and has room for it.
 *
 * The entitlement is read here rather than trusted from the caller, and the
 * quota is `server_entitlements.max_servers` — which only the webhook writes.
 * There is no argument to this function that can raise either.
 */
export async function createServer(
  db: Db,
  ownerPlayerId: string,
  input: { name: string; description?: string }
): Promise<CreateServerOutcome> {
  const name = cleanServerName(input?.name);
  if (name.length < 3) return { ok: false, reason: 'invalid_name' };
  const base = slugify(name);
  if (!base) return { ok: false, reason: 'invalid_name' };

  /* Read through `premium.ts` rather than querying the column here, so the
   * "does this permit hosting?" rule has ONE definition. Two copies of it drift,
   * and the copy that drifts is always the one nobody remembers exists — which
   * is the argument `recordSitePurchase` already makes about schema. */
  const entitlement = await readEntitlement(db, ownerPlayerId);
  if (!entitlementPermitsHosting(entitlement)) return { ok: false, reason: 'no_entitlement' };

  const owned = await db.query(
    `SELECT COUNT(*)::int AS n FROM custom_servers WHERE owner_player_id = $1`,
    [ownerPlayerId]
  );
  if (Number(owned.rows[0]?.n ?? 0) >= entitlement.maxServers) {
    return { ok: false, reason: 'quota' };
  }

  const id = randomUUID();
  /* One INSERT with the uniqueness left to the database, rather than a SELECT
   * that checks the slug first: a check-then-act is two requests away from both
   * passing, which is the same argument the credit ledger makes for its own
   * idempotency. */
  const created = await db.query(
    `INSERT INTO custom_servers (id, owner_player_id, name, slug, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (slug) DO NOTHING
     RETURNING ${SERVER_COLS}`,
    [id, ownerPlayerId, name, base, String(input?.description ?? '').slice(0, 2000)]
  );
  if (!created.rows[0]) return { ok: false, reason: 'slug_taken' };

  /* The owner is a member of their own server, so every membership-shaped
   * query has one answer rather than "approved, or the owner". */
  await db.query(
    `INSERT INTO server_members (server_id, player_id, state)
     VALUES ($1, $2, 'approved')
     ON CONFLICT (server_id, player_id) DO UPDATE SET state = 'approved', updated_at = NOW()`,
    [id, ownerPlayerId]
  );

  return { ok: true, server: toServer(created.rows[0] as ServerRow) };
}

export async function getServer(db: Db, serverId: string): Promise<CustomServer | null> {
  if (!serverId) return null;
  const r = await db.query(`SELECT ${SERVER_COLS} FROM custom_servers WHERE id = $1`, [serverId]);
  return r.rows[0] ? toServer(r.rows[0] as ServerRow) : null;
}

export async function listServersOwnedBy(db: Db, ownerPlayerId: string): Promise<CustomServer[]> {
  const r = await db.query(
    `SELECT ${SERVER_COLS} FROM custom_servers WHERE owner_player_id = $1 ORDER BY created_at`,
    [ownerPlayerId]
  );
  return (r.rows as ServerRow[]).map(toServer);
}

/** Every server, for the platform admin. The only unscoped list in this file. */
export async function listAllServers(db: Db): Promise<CustomServer[]> {
  const r = await db.query(`SELECT ${SERVER_COLS} FROM custom_servers ORDER BY created_at DESC`);
  return (r.rows as ServerRow[]).map(toServer);
}

export async function updateServer(
  db: Db,
  serverId: string,
  patch: { name?: string; description?: string; status?: 'active' | 'suspended' }
): Promise<CustomServer | null> {
  const current = await getServer(db, serverId);
  if (!current) return null;
  const name = patch.name === undefined ? current.name : cleanServerName(patch.name);
  if (!name || name.length < 3) return current;
  const r = await db.query(
    `UPDATE custom_servers
        SET name = $1, description = $2, status = $3, updated_at = NOW()
      WHERE id = $4
      RETURNING ${SERVER_COLS}`,
    [
      name,
      patch.description === undefined ? current.description : String(patch.description).slice(0, 2000),
      /* ABSENT MEANS UNCHANGED, like `name` and `description` two lines up.
       * This read `patch.status === 'suspended' ? 'suspended' : 'active'`, so an
       * omitted status coerced to `active` and any PATCH re-activated the row.
       * The route's own guard is correct - a non-admin asking to set `status`
       * gets a 403 - but a non-admin owner sending `{"name": "..."}` never asks,
       * and un-suspended their own server. Suspension is how a platform admin
       * contains an abusive server, so a suspension that any later edit undoes
       * is not containment at all. */
      patch.status === undefined
        ? current.status
        : (patch.status === 'suspended' ? 'suspended' : 'active'),
      serverId,
    ]
  );
  return r.rows[0] ? toServer(r.rows[0] as ServerRow) : null;
}

/* ---------------------------------------------------------------------- */
/* Membership                                                              */
/* ---------------------------------------------------------------------- */

export async function memberState(
  db: Db,
  serverId: string,
  playerId: string
): Promise<MemberState | null> {
  if (!serverId || !playerId) return null;
  const r = await db.query(
    `SELECT state FROM server_members WHERE server_id = $1 AND player_id = $2`,
    [serverId, playerId]
  );
  const state = r.rows[0]?.state as MemberState | undefined;
  return state && (MEMBER_STATES as readonly string[]).includes(state) ? state : null;
}

/**
 * May this player see and use this server's content?
 *
 * One function, so every content read has the same answer. A suspended server
 * answers false for everyone including its owner, because a suspended server
 * serving its owner is a suspension nobody enforced.
 */
export async function canUseServer(
  db: Db,
  serverId: string,
  playerId: string
): Promise<boolean> {
  const server = await getServer(db, serverId);
  if (!server || server.status !== 'active') return false;
  return isActiveMember(await memberState(db, serverId, playerId));
}

export type MembershipRefusal = 'not_found' | 'forbidden' | 'illegal_transition';

export type MembershipOutcome =
  | { ok: true; state: MemberState; changed: boolean }
  | { ok: false; reason: MembershipRefusal };

/**
 * Move one membership, refusing anything the table does not allow.
 *
 * `actorPlayerId` is checked against the server's owner for the owner-side
 * verbs and against the subject for the player-side one. That check is here
 * rather than in the route because there are several routes and one rule, and
 * an authorisation rule with several copies is a rule with several versions.
 */
export async function applyMembershipAction(
  db: Db,
  opts: {
    serverId: string;
    subjectPlayerId: string;
    actorPlayerId: string;
    action: MemberAction;
    /** A platform admin may act as the owner. Passed, never inferred. */
    platformAdmin?: boolean;
  }
): Promise<MembershipOutcome> {
  const { serverId, subjectPlayerId, actorPlayerId, action } = opts;
  const server = await getServer(db, serverId);
  if (!server) return { ok: false, reason: 'not_found' };

  const wants = ACTION_ACTOR[action];
  if (!wants) return { ok: false, reason: 'illegal_transition' };

  const isOwner = server.ownerPlayerId === actorPlayerId || !!opts.platformAdmin;
  if (wants === 'owner' && !isOwner) return { ok: false, reason: 'forbidden' };
  if (wants === 'player' && actorPlayerId !== subjectPlayerId) {
    return { ok: false, reason: 'forbidden' };
  }

  /* The owner's own membership is not removable. Otherwise an owner can eject
   * themselves from a server only they can administer, and the server is then
   * ownerless with no route that can fix it. */
  if (server.ownerPlayerId === subjectPlayerId && (action === 'remove' || action === 'reject')) {
    return { ok: false, reason: 'forbidden' };
  }

  const from = await memberState(db, serverId, subjectPlayerId);
  const to = nextMemberState(action, from);
  if (!to) return { ok: false, reason: 'illegal_transition' };

  await db.query(
    `INSERT INTO server_members (server_id, player_id, state, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (server_id, player_id)
     DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
    [serverId, subjectPlayerId, to, action === 'invite' ? actorPlayerId : null]
  );

  /* Ejected members do not keep playing in the server they were ejected from.
   * Cleared here rather than filtered at read, which is the same argument the
   * leaderboard makes: a filter is a gate that can be forgotten. */
  if (to === 'removed') {
    await db.query(
      `UPDATE player_server_selection SET server_id = NULL, updated_at = NOW()
        WHERE player_id = $1 AND server_id = $2`,
      [subjectPlayerId, serverId]
    );
  }

  return { ok: true, state: to, changed: from !== to };
}

export async function listMembers(db: Db, serverId: string): Promise<Membership[]> {
  const r = await db.query(
    `SELECT m.server_id, m.player_id, m.state, m.updated_at, pl.handle
       FROM server_members m
       LEFT JOIN players pl ON pl.id = m.player_id
      WHERE m.server_id = $1
      ORDER BY m.state, pl.handle NULLS LAST, m.player_id`,
    [serverId]
  );
  return r.rows.map((row) => ({
    serverId: String(row.server_id),
    playerId: String(row.player_id),
    state: String(row.state) as MemberState,
    handle: row.handle ?? null,
    updatedAt: String(row.updated_at ?? ''),
  }));
}

/** Every server this player may enter, plus any they have asked about. */
export async function listServersForPlayer(
  db: Db,
  playerId: string
): Promise<Array<CustomServer & { state: MemberState }>> {
  const r = await db.query(
    `SELECT s.id, s.owner_player_id, s.name, s.slug, s.description, s.status, s.created_at,
            m.state
       FROM server_members m
       JOIN custom_servers s ON s.id = m.server_id
      WHERE m.player_id = $1 AND m.state <> 'removed'
      ORDER BY s.name`,
    [playerId]
  );
  return r.rows.map((row) => ({
    ...toServer(row as ServerRow),
    state: String(row.state) as MemberState,
  }));
}

/**
 * Servers a player could ask to join: active, and not already theirs.
 *
 * Every active server is discoverable. That is a product choice rather than a
 * security one — the catalogue is not secret, and a server nobody can find is a
 * server nobody can request. Nothing about a server's CONTENT is served here.
 */
export async function listJoinableServers(db: Db, playerId: string): Promise<CustomServer[]> {
  const r = await db.query(
    `SELECT ${SERVER_COLS} FROM custom_servers s
      WHERE s.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM server_members m
           WHERE m.server_id = s.id AND m.player_id = $1 AND m.state <> 'removed'
        )
      ORDER BY s.name`,
    [playerId]
  );
  return (r.rows as ServerRow[]).map(toServer);
}

/* ---------------------------------------------------------------------- */
/* Which server a player is playing in                                     */
/* ---------------------------------------------------------------------- */

/**
 * Choose default mode (`null`) or a server.
 *
 * Refuses a server the player may not use, and answers with what was actually
 * stored rather than with what was asked for — so a caller that ignores the
 * refusal still cannot show the player a server they are not in.
 */
export async function selectServer(
  db: Db,
  playerId: string,
  serverId: string | null
): Promise<{ serverId: string | null; refused: boolean }> {
  if (serverId && !(await canUseServer(db, serverId, playerId))) {
    const current = await currentServerId(db, playerId);
    return { serverId: current, refused: true };
  }
  await db.query(
    `INSERT INTO player_server_selection (player_id, server_id)
     VALUES ($1, $2)
     ON CONFLICT (player_id) DO UPDATE SET server_id = EXCLUDED.server_id, updated_at = NOW()`,
    [playerId, serverId]
  );
  return { serverId, refused: false };
}

/**
 * The server this player is in, or null for default mode.
 *
 * Re-checks membership on every read. A stored selection is not an entitlement:
 * an owner can remove a member between one request and the next, and a player
 * whose membership ended must fall back to default mode rather than keep the
 * catalogue they were shown last.
 */
export async function currentServerId(db: Db, playerId: string): Promise<string | null> {
  const r = await db.query(
    `SELECT server_id FROM player_server_selection WHERE player_id = $1`,
    [playerId]
  );
  const stored = r.rows[0]?.server_id;
  if (!stored) return null;
  return (await canUseServer(db, String(stored), playerId)) ? String(stored) : null;
}

/* ---------------------------------------------------------------------- */
/* Presence                                                                */
/* ---------------------------------------------------------------------- */

/** How long after a heartbeat a player still counts as active. */
export const PRESENCE_WINDOW_SECONDS = 120;

export async function touchPresence(db: Db, serverId: string, playerId: string): Promise<void> {
  await db.query(
    `INSERT INTO server_presence (server_id, player_id, last_seen)
     VALUES ($1, $2, NOW())
     ON CONFLICT (server_id, player_id) DO UPDATE SET last_seen = NOW()`,
    [serverId, playerId]
  );
}

export interface ActivePlayer {
  playerId: string;
  handle: string | null;
}

/**
 * Who is in this server now — the addressable list for a direct message.
 *
 * Approved members only, so a removed member's stale presence row cannot be
 * messaged and cannot appear in a roster.
 */
export async function listActivePlayers(db: Db, serverId: string): Promise<ActivePlayer[]> {
  const r = await db.query(
    `SELECT p.player_id, pl.handle
       FROM server_presence p
       JOIN server_members m
         ON m.server_id = p.server_id AND m.player_id = p.player_id AND m.state = 'approved'
       LEFT JOIN players pl ON pl.id = p.player_id
      WHERE p.server_id = $1
        AND p.last_seen > NOW() - ($2 || ' seconds')::interval
      ORDER BY pl.handle NULLS LAST, p.player_id`,
    [serverId, String(PRESENCE_WINDOW_SECONDS)]
  );
  return r.rows.map((row) => ({
    playerId: String(row.player_id),
    handle: row.handle ?? null,
  }));
}
