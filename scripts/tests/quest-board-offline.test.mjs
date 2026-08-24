import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DOES THE QUEST BOARD SAY "OFFLINE" RATHER THAN "EMPTY"?
 *
 * `QuestSystem` emits `quests:changed` with `offline: true` when the quest
 * service is unreachable, and its own comment says why: "so it can say offline
 * rather than empty — the same distinction the marketplace draws."
 *
 * The board's handler was a NO-ARGUMENT arrow, so the flag was dropped and the
 * word "offline" appeared nowhere in the file. The sender was right; the
 * receiver threw the distinction away, and nothing anywhere noticed.
 *
 * It is not cosmetic. While `/api/game/quests` was returning HTTP 500 to every
 * caller in production, the marketplace displayed "Trade network unreachable"
 * and the quest board displayed "No quests in this category" — so a total
 * outage of 78 quests read to a player as a world with nothing to do in it.
 *
 * A source scrape rather than a DOM test, deliberately: what failed is that a
 * handler did not take its argument, and that is visible in the source without
 * standing up a document. The assertions are about the DATA PATH — that the
 * payload is bound and the flag is read — not about the wording, which should
 * be free to change.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, '..', '..', 'src', 'ui', 'QuestBoard.js'), 'utf8')
  .replace(/\r\n/g, '\n');
const system = readFileSync(join(HERE, '..', '..', 'src', 'systems', 'QuestSystem.js'), 'utf8')
  .replace(/\r\n/g, '\n');

test('QuestSystem still sends the offline flag, so the receiver has something to read', () => {
  assert.ok(system.includes('offline: true'),
    'QuestSystem no longer marks an unreachable service — the board cannot report what it is not told');
});

test('the board binds the quests:changed payload instead of dropping it', () => {
  const handler = src.match(/bus\.on\('quests:changed',\s*\(([^)]*)\)/);
  assert.ok(handler, "the board must subscribe to 'quests:changed'");
  assert.notEqual(handler[1].trim(), '',
    'the handler takes no argument, so `offline` is dropped on the floor — this is the exact ' +
    'shape that turned a 500 from every quest endpoint into "No quests in this category"');
});

test('the board reads the flag and distinguishes the two states', () => {
  assert.ok(/offline\s*===\s*true|\.offline\b/.test(src),
    'the payload is bound but never read');
  assert.ok(src.includes('_offline'),
    'the flag must be held somewhere the render can see it');

  /* Two different strings for two different facts. An unreachable service and
   * an empty category are not the same thing, and only one of them is
   * something the player can act on. */
  const emptyBranch = src.match(/qb-empty[\s\S]{0,400}/);
  assert.ok(emptyBranch, 'the empty-state branch must exist');
  assert.ok(/unreachable/i.test(src),
    'nothing in the board tells a player the service is unreachable');
});
