import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailySeed, utcDayKey, PLATFORM_SEED_SALT } from './customServers';

/**
 * THE SHARED DAILY SEED, AND THE THREE WAYS IT COULD SILENTLY STOP BEING SHARED.
 *
 * The whole value of this number is that two clients arrive at the same maze
 * without talking to each other. Every property below is one of the ways that
 * could fail while everything still looked like it worked:
 *
 *   1. The function stops being pure — a `Math.random`, a `Date.now` read
 *      inside, an object key order. Two players get two mazes and neither can
 *      tell, because each one's maze is perfectly valid.
 *   2. The day boundary stops being UTC. Then a player in Auckland and one in
 *      Los Angeles are on different seeds for twenty-one hours a day.
 *   3. The seed stops reaching the client. `/api/game/session` is the only
 *      carrier; if the field is dropped the game falls back to a private random
 *      roll and, again, nothing is red.
 *
 * `MazeWorld.adoptDailySeed` — the consumer, and the validation of the number
 * once it lands — is gated on the game side, in
 * `scripts/tests/shared-daily-seed.test.mjs`, because it needs the real world
 * module and `site/` cannot import one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/** Read a repo file with line endings normalised. This tree checks out CRLF. */
function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
}

describe('utcDayKey', () => {
  it('is the UTC date, not the local one', () => {
    /* 23:30 UTC on the 5th. Every timezone east of UTC is already on the 6th
     * locally, and a `toLocaleDateString` or a `getDate()` would say so. */
    expect(utcDayKey(new Date(Date.UTC(2026, 8, 5, 23, 30, 0)))).toBe('2026-09-05');
    /* And 00:30 UTC on the 6th, which is still the 5th in the Americas. */
    expect(utcDayKey(new Date(Date.UTC(2026, 8, 6, 0, 30, 0)))).toBe('2026-09-06');
  });

  it('pads every field, so the key is always the same width', () => {
    /* A key whose width changes changes the hash, and the two dates that do it
     * are exactly the ones nobody tries by hand. */
    expect(utcDayKey(new Date(Date.UTC(2026, 0, 1)))).toBe('2026-01-01');
    expect(utcDayKey(new Date(Date.UTC(2026, 8, 9)))).toBe('2026-09-09');
    expect(utcDayKey(new Date(Date.UTC(999, 0, 1)))).toBe('0999-01-01');
  });
});

describe('dailySeed', () => {
  const DAY = new Date(Date.UTC(2026, 8, 1, 12, 0, 0));
  const NEXT = new Date(Date.UTC(2026, 8, 2, 12, 0, 0));

  it('is pure: the same server and day always give the same number', () => {
    const a = dailySeed('server-alpha', DAY);
    for (let i = 0; i < 50; i++) {
      expect(dailySeed('server-alpha', DAY)).toBe(a);
    }
  });

  it('gives every member of one server the same maze, and only them', () => {
    /* This is the feature, stated as an assertion: the seed depends on WHO the
     * server is and WHEN, and on nothing else. No player id anywhere. */
    expect(dailySeed('server-alpha', DAY)).toBe(dailySeed('server-alpha', DAY));
    expect(dailySeed('server-alpha', DAY)).not.toBe(dailySeed('server-beta', DAY));
  });

  it('re-rolls tomorrow, which is what keeps the maze unlearnable', () => {
    expect(dailySeed('server-alpha', DAY)).not.toBe(dailySeed('server-alpha', NEXT));
  });

  it('holds across the whole UTC day and changes exactly at its boundary', () => {
    const start = dailySeed('s', new Date(Date.UTC(2026, 8, 1, 0, 0, 0)));
    const end = dailySeed('s', new Date(Date.UTC(2026, 8, 1, 23, 59, 59, 999)));
    const over = dailySeed('s', new Date(Date.UTC(2026, 8, 2, 0, 0, 0)));
    expect(end).toBe(start);
    expect(over).not.toBe(start);
  });

  it('salts platform play rather than answering null', () => {
    /* One code path on the client, not a seed-or-no-seed branch exercised by
     * half the players. Signed-in default-mode players share a maze too. */
    expect(dailySeed(null, DAY)).toBe(dailySeed(PLATFORM_SEED_SALT, DAY));
    expect(dailySeed(undefined, DAY)).toBe(dailySeed(null, DAY));
    expect(dailySeed('   ', DAY)).toBe(dailySeed(null, DAY));
    /* And it is a different maze from any real server's, because no server id
     * is the literal 'platform' — they are UUIDs. */
    expect(dailySeed(null, DAY)).not.toBe(dailySeed('server-alpha', DAY));
  });

  it('lands in the range MazeWorld.build() rolls for itself', () => {
    /* `(Math.random() * 0xffffffff) >>> 0`. A value outside that is not wrong
     * for the topology generator, but "the shared maze is one you could have
     * rolled" is worth keeping true — and `adoptDailySeed` REFUSES anything
     * outside it, so a seed out of range would be silently ignored. */
    for (let d = 1; d <= 28; d++) {
      for (const server of [null, 'a', 'b-longer-id', '00000000-0000-4000-8000-000000000009']) {
        const n = dailySeed(server, new Date(Date.UTC(2026, 8, d)));
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });

  it('spreads: a month of days for one server are not all the same maze', () => {
    /* FNV-1a over inputs that differ in one digit is exactly the case a weak
     * hash collapses on, and a collapsed hash reads as "the maze never
     * changes" — a bug reported as a feeling, weeks later. */
    const seen = new Set<number>();
    for (let d = 1; d <= 28; d++) seen.add(dailySeed('server-alpha', new Date(Date.UTC(2026, 8, d))));
    expect(seen.size).toBe(28);
  });
});

describe('the carrier', () => {
  it('/api/game/session puts the seed and its day on the wire', () => {
    /* The only path from `dailySeed` to the game. Asserted against the route's
     * source because there is no other way to notice the field being dropped:
     * the client treats a missing seed as "roll your own", which is exactly
     * what it did before this existed and looks identical from the outside. */
    const route = read('site', 'app', 'api', 'game', 'session', 'route.ts');
    expect(route).toMatch(/daily_seed:\s*dailySeed\(serverId/);
    expect(route).toMatch(/daily_seed_day:\s*utcDayKey\(/);
  });

  it('derives the seed from the server the SESSION resolved, never a request field', () => {
    /* `GET()` takes no Request at all, so there is no query parameter to read;
     * `serverId` is `currentServer(profile.playerId)`, which re-checks
     * membership. A seed a client could nominate is a seed that is not shared. */
    const route = read('site', 'app', 'api', 'game', 'session', 'route.ts');
    expect(route).toMatch(/export async function GET\(\)/);
    expect(route).toMatch(/const serverId = await currentServer\(profile\.playerId\)/);
  });
});
