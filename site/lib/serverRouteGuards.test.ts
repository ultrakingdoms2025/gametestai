import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The seven custom-server routes, held to the rules that are theirs to keep.
 *
 * Modelled on `adminRouteGuards.test.ts`, which already pins the marketplace
 * admin routes this way, and on `leaderboard.test.ts`'s "there is no POST on
 * this route" assertion. A route handler cannot be imported under vitest — it
 * pulls in next-auth and `pg` at module scope — so the surface is checked
 * textually. That is a narrow claim and it is the claim that matters: the
 * failures being guarded against are a missing auth call and a scope read from
 * a request body, both of which are visible in the text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', 'app');

/** CRLF-normalised: `core.autocrlf` is true in this repository. */
function route(...parts: string[]): string {
  const path = join(app, ...parts, 'route.ts');
  if (!existsSync(path)) throw new Error(`no route at ${parts.join('/')}`);
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/** Every route added or changed by this phase. */
const ROUTES: Array<[string, string[]]> = [
  ['servers', ['api', 'servers']],
  ['servers/[id]', ['api', 'servers', '[id]']],
  ['servers/[id]/members', ['api', 'servers', '[id]', 'members']],
  ['servers/[id]/members/search', ['api', 'servers', '[id]', 'members', 'search']],
  ['servers/[id]/content', ['api', 'servers', '[id]', 'content']],
  ['game/server', ['api', 'game', 'server']],
  ['game/chat', ['api', 'game', 'chat']],
  ['game/server-credits', ['api', 'game', 'server-credits']],
];

describe('every custom-server route establishes who is calling', () => {
  it.each(ROUTES)('%s resolves an actor in every handler', (_name, parts) => {
    const src = route(...parts);
    const handlers = src.match(/export async function (GET|POST|PATCH|DELETE|PUT)/g) ?? [];
    expect(handlers.length, 'a route file with no handlers').toBeGreaterThan(0);
    /* One `resolveActor()` per exported handler. A handler that forgot it is a
     * handler anybody can call, and the count is what catches "four handlers,
     * three calls". */
    const resolves = src.match(/await resolveActor\(\)/g) ?? [];
    expect(resolves.length).toBe(handlers.length);
  });

  it.each(ROUTES)('%s refuses an unauthenticated caller with 401', (_name, parts) => {
    const src = route(...parts);
    const handlers = (src.match(/export async function (GET|POST|PATCH|DELETE|PUT)/g) ?? []).length;
    const refusals = src.match(/status: 401/g) ?? [];
    expect(refusals.length).toBe(handlers);
  });
});

describe('the content scope is never taken from the request', () => {
  it('the owner CRUD stamps from the URL, not from the body', () => {
    /* The residual `leaderboard.ts` handed this phase, at the route layer. The
     * server id passed to `serverContent` is `id` — the path parameter whose
     * ownership this handler has already checked — and there is no field in any
     * body named `serverId` for a client to supply or forge. */
    const src = route('api', 'servers', '[id]', 'content');
    expect(src).toMatch(/const \{ id \} = await params;/);
    expect(src).not.toMatch(/body\.serverId/);
    expect(src).not.toMatch(/serverId:\s*String\(body\./);

    /* Every serverContent call binds `id`. Checked by counting rather than by
     * spot-reading, so a ninth call added later cannot quietly pass something
     * else. */
    const calls = src.match(/await (create|update|delete|upsert|retire|list)Server\w+\(db, ([^,)]+)/g) ?? [];
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) expect(call, call).toMatch(/\(db, id\b/);
  });

  it('chat and server credits resolve the scope from the selection', () => {
    for (const parts of [['api', 'game', 'chat'], ['api', 'game', 'server-credits']]) {
      const src = route(...parts);
      expect(src, parts.join('/')).toContain('await currentServerId(db, actor.playerId)');
      /* No `serverId` anywhere in a parsed body. A client that could name the
       * server could name somebody else's. */
      expect(src, parts.join('/')).not.toMatch(/body\.serverId/);
      expect(src, parts.join('/')).not.toMatch(/searchParams\.get\('server'\)/);
    }
  });

  it('the player-side join request cannot act on anybody else', () => {
    /* `applyMembershipAction` refuses a player acting on another player, and
     * this route cannot even express the attempt: the caller is passed as both
     * actor and subject. */
    const src = route('api', 'game', 'server');
    const request = /action: 'request',/.test(src);
    expect(request).toBe(true);
    expect(src).toMatch(/subjectPlayerId: actor\.playerId,\s*\n\s*actorPlayerId: actor\.playerId,/);
  });

  it('the owner-side membership route offers no player-side verb', () => {
    const src = route('api', 'servers', '[id]', 'members');
    expect(src).toMatch(/OWNER_ACTIONS: MemberAction\[\] = \['invite', 'approve', 'reject', 'remove'\]/);
    /* `request` is deliberately absent, so the two audiences never share an
     * endpoint and an owner cannot "request" somebody into their server. */
    expect(src).not.toMatch(/OWNER_ACTIONS.*'request'/);
  });
});

describe('the invite search route', () => {
  /* A directory query over every player account. The guardrails are the
   * design: owner-gated, two characters minimum, handle only — and they are
   * pinned here because each one, lost, is a different leak. */

  it('is owner-gated BEFORE it answers anything, including "too short"', () => {
    const src = route('api', 'servers', '[id]', 'members', 'search');
    const gateAt = src.indexOf('requireOwnedServer');
    const lengthAt = src.indexOf('MEMBER_SEARCH_MIN_QUERY', gateAt + 1);
    const searchAt = src.indexOf('searchInvitablePlayers(');
    expect(gateAt).toBeGreaterThan(-1);
    /* Ownership first: a non-owner probing with a one-character query must
     * learn "not found", not "a server exists and your query was short". */
    expect(lengthAt).toBeGreaterThan(gateAt);
    expect(searchAt).toBeGreaterThan(lengthAt);
  });

  it('refuses a short query with a 400 rather than answering broadly', () => {
    const src = route('api', 'servers', '[id]', 'members', 'search');
    expect(src).toMatch(/q\.length < MEMBER_SEARCH_MIN_QUERY/);
    expect(src).toMatch(/status: 400/);
  });

  it('never so much as names an email column, in the route or the query', () => {
    const src = route('api', 'servers', '[id]', 'members', 'search');
    /* Not "redacts" — never touches. There is no email to strip from a payload
     * whose SELECT never read one. The route's PROSE names email (its privacy
     * note is required to), so the claim is made of the code alone. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/^\s*\*.*$/gm, '');
    expect(code).not.toMatch(/email/i);

    const lib = readFileSync(join(here, 'customServers.ts'), 'utf8').replace(/\r\n/g, '\n');
    const fnAt = lib.indexOf('export async function searchInvitablePlayers');
    expect(fnAt).toBeGreaterThan(-1);
    const fn = lib.slice(fnAt, lib.indexOf('\n}', fnAt));
    expect(fn).toMatch(/SELECT id, handle\s*\n\s*FROM players/);
    expect(fn).not.toMatch(/email/i);
    expect(fn).toContain('LIMIT');
  });
});

describe('the game session bootstrap', () => {
  it('resolves the current server on the server side and cannot be told one', () => {
    const src = route('api', 'game', 'session');
    /* The handler takes NO Request at all, so there is no query string, no
     * body and no header for a client to name a server through. */
    expect(src).toMatch(/export async function GET\(\)/);
    expect(src).not.toMatch(/searchParams/);
    /* `server` is `server_id` with its name attached, resolved through the
     * same membership-re-checking read (`currentServer` → `currentServerId`)
     * the content routes use. */
    expect(src).toMatch(/currentServer\(profile\.playerId\)/);
    expect(src).toMatch(/getServer\(db, serverId\)/);
    expect(src).toMatch(/server,\s*\n\s*\}\);/);
  });

  it('the launch directory rides the game/server read, scoped to the caller', () => {
    const src = route('api', 'game', 'server');
    expect(src).toMatch(/directory: await listServersDirectory\(db, actor\.playerId\)/);
    /* And the deliberately narrower list survives beside it: `joinable` keeps
     * its exclusion rule for its own consumers. */
    expect(src).toMatch(/joinable: await listJoinableServers\(db, actor\.playerId\)/);
  });
});

describe('the leaderboard route', () => {
  it('still has no way to submit a score', () => {
    /* Phase 3 §9's rule, re-asserted because this phase touched the file: the
     * endpoint derives from identity sets the server already holds. A submit
     * handler is the entire hole. */
    const src = route('api', 'game', 'leaderboard');
    expect(src).toMatch(/export async function GET/);
    expect(src).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });

  it('checks membership before it serves a per-server board', () => {
    const src = route('api', 'game', 'leaderboard');
    /* One function decides membership across content, chat and boards. A second
     * opinion here would be a second definition of who is in a server. */
    expect(src).toContain('canUseServer');
    const checkAt = src.indexOf('canUseServer(check, requested, playerId)');
    const scopeAt = src.indexOf('scope = { serverId: requested }');
    expect(checkAt).toBeGreaterThan(-1);
    expect(scopeAt).toBeGreaterThan(checkAt);
  });
});

describe('the platform admin surface', () => {
  it('is the only unscoped list, and it is gated on the allowlist', () => {
    const src = route('api', 'servers');
    expect(src).toContain('listAllServers');
    /* Gated on `actor.platformAdmin`, which is `isAllowedAdminEmail` — the
     * allowlist that fails CLOSED when unconfigured. That default used to grant,
     * and it was the live branch in production. */
    expect(src).toMatch(/actor\.platformAdmin \? await listAllServers\(db\) : null/);
  });

  it('cannot be claimed by a request', () => {
    for (const [, parts] of ROUTES) {
      const src = route(...parts);
      expect(src, parts.join('/')).not.toMatch(/body\.platformAdmin/);
      expect(src, parts.join('/')).not.toMatch(/platformAdmin:\s*true(?!\s*[,}])/);
    }
  });
});
