import type { Client, PoolClient } from 'pg';
import { canUseServer, memberState, isActiveMember } from './customServers';

/**
 * Scoped chat (7e): direct messages to selected active players, and a
 * server-wide shout.
 *
 * ── There was no player-to-player chat before this ────────────────────────
 *
 * `server/chat-server.js` is a dev-only Express process that asks an LLM to
 * answer as an NPC. It is not a message bus, it does not run in production, and
 * nothing in it is reusable here. This is the first player-to-player channel in
 * the project.
 *
 * ── Polled HTTP, and why that is not a compromise ─────────────────────────
 *
 * Decision D2 removed the shared live world instance, so there is no process
 * holding two players' connections and nothing to attach a socket to. Vercel
 * functions do not hold one either. Postgres plus a cursor is therefore the
 * delivery mechanism the architecture leaves, and it is sufficient: chat is the
 * only thing being delivered, and a message that arrives within a poll interval
 * is a message that arrived.
 *
 * The cursor is `BIGSERIAL id`, not a timestamp. Two rows can share a
 * millisecond and clocks are not monotonic across a connection pool; an id is
 * assigned by one sequence and is strictly increasing, so "everything after N"
 * cannot skip a row or repeat one.
 *
 * ── Visibility is a WHERE clause, never a filter afterwards ───────────────
 *
 * A direct message is readable by exactly two people, and that test lives in the
 * SQL. A row the caller may not see is never returned to JavaScript at all, so
 * there is no post-filter to forget — the same argument `leaderboard.ts` makes
 * about its manifest, applied to a much smaller thing.
 *
 * Membership is asked on every send and every read rather than passed in. An
 * owner can remove a member between one poll and the next.
 */

/** Any pg client — a plain Client in tests, a pooled one in a route. */
type Db = Client | PoolClient;

/** Long enough for a sentence, short enough not to be a payload. */
export const CHAT_BODY_MAX = 400;

/**
 * One line of plain text, or '' if there is nothing left after cleaning.
 *
 * Newlines and control characters collapse to spaces rather than being stripped:
 * stripping joins the words either side, which turns a multi-line paste into
 * something the sender did not write.
 */
export function cleanChatBody(raw: unknown): string {
  /* Control bytes become spaces one code point at a time, rather than through a
   * character class: writing that class means putting raw control bytes in a
   * source file, where they are invisible in every editor and survive a paste
   * as something else. This loop says what it does. */
  let out = '';
  for (const ch of String(raw ?? '')) {
    const code = ch.codePointAt(0) ?? 32;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_BODY_MAX);
}

export interface ChatMessage {
  id: number;
  from: string;
  fromHandle: string | null;
  /** null for a shout. */
  to: string | null;
  body: string;
  createdAt: string;
}

export type SendRefusal = 'empty' | 'forbidden' | 'no_recipient' | 'too_fast';

export type SendOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: SendRefusal };

/** How many messages one player may send to one server inside the window. */
const RATE_MAX = 20;
const RATE_WINDOW_SECONDS = 30;

/**
 * Send a shout (`toPlayerId` absent) or a direct message.
 *
 * Order matters and is asserted by the tests: the body is cleaned first because
 * an empty message is not worth a round trip, then membership, then the
 * recipient, then the rate limit, and only then the write. A send that wrote
 * first and validated afterwards would leave the row behind.
 */
export async function sendChat(
  db: Db,
  serverId: string,
  fromPlayerId: string,
  input: { body: string; toPlayerId?: string | null }
): Promise<SendOutcome> {
  const body = cleanChatBody(input?.body);
  if (!body) return { ok: false, reason: 'empty' };

  if (!(await canUseServer(db, serverId, fromPlayerId))) {
    return { ok: false, reason: 'forbidden' };
  }

  const to = input?.toPlayerId ? String(input.toPlayerId) : null;
  if (to) {
    /* A direct message goes to a MEMBER, not to any player id the sender can
     * type. Otherwise chat is a channel for messaging strangers that happens to
     * be namespaced by a server. */
    if (!isActiveMember(await memberState(db, serverId, to))) {
      return { ok: false, reason: 'no_recipient' };
    }
  }

  const recent = await db.query(
    `SELECT COUNT(*)::int AS n FROM server_chat_messages
      WHERE server_id = $1 AND from_player_id = $2
        AND created_at > NOW() - ($3 || ' seconds')::interval`,
    [serverId, fromPlayerId, String(RATE_WINDOW_SECONDS)]
  );
  if (Number(recent.rows[0]?.n ?? 0) >= RATE_MAX) {
    return { ok: false, reason: 'too_fast' };
  }

  const r = await db.query(
    `INSERT INTO server_chat_messages (server_id, from_player_id, to_player_id, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [serverId, fromPlayerId, to, body]
  );
  return { ok: true, id: Number(r.rows[0]?.id ?? 0) };
}

export interface ChatPage {
  messages: ChatMessage[];
  /** Pass back as `sinceId` next poll. Unchanged when nothing arrived. */
  cursor: number;
  /** True when the caller is not (or is no longer) a member. */
  forbidden: boolean;
}

/**
 * Everything addressed to this player in this server after `sinceId`.
 *
 * The visibility test is the last three lines of the WHERE: a shout
 * (`to_player_id IS NULL`), a message to me, or a message from me. Nothing else
 * is selected, so nothing else can be returned.
 */
export async function readChat(
  db: Db,
  serverId: string,
  playerId: string,
  opts: { sinceId: number; limit: number }
): Promise<ChatPage> {
  if (!(await canUseServer(db, serverId, playerId))) {
    return { messages: [], cursor: Math.max(0, Math.trunc(opts?.sinceId) || 0), forbidden: true };
  }

  const since = Math.max(0, Math.trunc(opts?.sinceId) || 0);
  const limit = Math.max(1, Math.min(200, Math.trunc(opts?.limit) || 50));

  const r = await db.query(
    `SELECT m.id, m.from_player_id, m.to_player_id, m.body, m.created_at, pl.handle
       FROM server_chat_messages m
       LEFT JOIN players pl ON pl.id = m.from_player_id
      WHERE m.server_id = $1
        AND m.id > $2
        AND (m.to_player_id IS NULL
             OR m.to_player_id = $3
             OR m.from_player_id = $3)
      ORDER BY m.id
      LIMIT $4`,
    [serverId, since, playerId, limit]
  );

  const messages: ChatMessage[] = r.rows.map((row) => ({
    id: Number(row.id),
    from: String(row.from_player_id),
    fromHandle: row.handle ?? null,
    to: row.to_player_id == null ? null : String(row.to_player_id),
    body: String(row.body ?? ''),
    createdAt: String(row.created_at ?? ''),
  }));

  return {
    messages,
    cursor: messages.length ? messages[messages.length - 1].id : since,
    forbidden: false,
  };
}
