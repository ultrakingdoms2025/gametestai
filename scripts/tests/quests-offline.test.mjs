import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE BUNDLED QUEST BOARD, PINNED TO THE THING THE DATABASE IS SEEDED FROM.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GUARDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `src/systems/QuestsOffline.mjs` is a COPY of the authored content in
 * `admin/lib/quests/*.mjs`, and its header says why it is a copy rather than an
 * import: `admin/` is a separate Next application with its own package and its
 * own deploy, and the game bundle must not depend on that tree.
 *
 * Copies rot. `MarketplaceOffline` has the same shape and the same problem and
 * solves it the same way - `marketplace-offline.test.mjs` parses the
 * server-side TypeScript and compares row by row - and the reason both exist is
 * written down in `admin/lib/quests/index.mjs`: a 100-line quest array in
 * `db.ts` plus a near-identical duplicate in `seed-quests.ts` "is exactly how
 * fifty quests drifted into being 0-for-50 completable without anyone
 * noticing".
 *
 * So this file reads the SAME module the seeder reads - `loadSeedQuests()` in
 * `scripts/quest-vocab.mjs` imports `admin/lib/quests/index.mjs` and takes
 * `ALL_QUESTS` - and asserts every field of every quest and every step. A quest
 * edited on one side and not the other is a red test here, not a board quietly
 * offering last month's content to every signed-out player.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND WHAT IT DELIBERATELY DOES NOT GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `notes` is an author's note to the next author and no player-facing surface
 * reads it, so it is not copied and not compared. Everything a board, a step
 * matcher or a payout reads IS.
 */

const { loadSeedQuests } = await import('../quest-vocab.mjs');
const { OFFLINE_QUESTS, offlineQuests, offlineQuestId } =
  await import('../../src/systems/QuestsOffline.mjs');

const SEED = await loadSeedQuests();

/* ================================================================== */
/* 1. The bundle IS the seed                                           */
/* ================================================================== */

test('the bundle carries every seeded quest, and no others', () => {
  assert.equal(OFFLINE_QUESTS.length, SEED.length,
    `the bundle has ${OFFLINE_QUESTS.length} quests and admin/lib/quests has ${SEED.length}. `
    + 'Regenerate the bundle: it is a copy, and this is the copy having drifted.');

  const seedNumbers = SEED.map((q) => q.n).sort((a, b) => a - b);
  const bundleNumbers = OFFLINE_QUESTS.map((q) => q.quest_number).sort((a, b) => a - b);
  assert.deepEqual(bundleNumbers, seedNumbers,
    'the bundle and the seed disagree about which quest numbers exist');
});

test('every field a player-facing surface reads matches the seed exactly', () => {
  const byNumber = new Map(OFFLINE_QUESTS.map((q) => [q.quest_number, q]));
  for (const s of SEED) {
    const b = byNumber.get(s.n);
    assert.ok(b, `quest ${s.n} ("${s.title}") is seeded but not bundled`);

    const where = `quest ${s.n} ("${s.title}")`;
    assert.equal(b.world, s.world, `${where}: world`);
    assert.equal(b.quest_line, s.line, `${where}: quest_line`);
    assert.equal(b.title, s.title, `${where}: title`);
    /* The reward is the one field a drift in would be invisible AND expensive:
     * the board draws it, the player picks a quest by it, and the server pays
     * its own copy. A bundle promising 900 for a quest the database pays 90 for
     * is a lie the player only finds out after doing the work. */
    assert.equal(b.reward_credits, s.credits, `${where}: reward_credits`);
    assert.equal(b.duration_minutes, s.dur ?? null, `${where}: duration_minutes`);
    assert.deepEqual(b.pre ?? null, s.pre ?? null, `${where}: prerequisites`);
  }
});

test('every step matches the seed, field for field', () => {
  const byNumber = new Map(OFFLINE_QUESTS.map((q) => [q.quest_number, q]));
  let steps = 0;
  for (const s of SEED) {
    const b = byNumber.get(s.n);
    const seedSteps = s.steps ?? [];
    assert.equal(b.steps.length, seedSteps.length,
      `quest ${s.n} has ${seedSteps.length} authored steps and ${b.steps.length} bundled ones`);
    for (let i = 0; i < seedSteps.length; i++) {
      const a = seedSteps[i];
      const c = b.steps[i];
      const where = `quest ${s.n} step ${a.order} ("${a.label}")`;
      assert.equal(c.order, a.order, `${where}: order`);
      assert.equal(c.label, a.label, `${where}: label`);
      /* `type` and `target` are the SUBSCRIPTION - they decide whether the step
       * can ever complete. A drift here is the 0-for-50 failure exactly. */
      assert.equal(c.type, a.type, `${where}: type`);
      assert.equal(c.target ?? null, a.target ?? null, `${where}: target`);
      assert.equal(c.count, a.count, `${where}: count`);
      assert.equal(c.world ?? null, a.world ?? null, `${where}: world`);
      steps++;
    }
  }
  assert.ok(steps > 300, `only ${steps} steps compared; the seed has hundreds`);
});

/* ================================================================== */
/* 2. The rows are the shape the client already reads                  */
/* ================================================================== */

test('offlineQuests returns rows in the API row shape, per world', () => {
  const worlds = [...new Set(SEED.map((q) => q.world))];
  assert.ok(worlds.length >= 6, `only ${worlds.length} worlds are seeded`);

  let total = 0;
  for (const world of worlds) {
    const rows = offlineQuests(world);
    const expected = SEED.filter((q) => q.world === world).length;
    assert.equal(rows.length, expected, `${world}: ${rows.length} rows for ${expected} quests`);
    total += rows.length;

    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].quest_number < rows[i].quest_number,
        `${world}: rows are not in quest_number order, which is the order the API promises`);
    }
    for (const r of rows) {
      assert.equal(r.world, world);
      assert.equal(r.id, offlineQuestId(r.quest_number));
      assert.equal(r.offline, true, 'a bundled row must declare itself, or the board cannot say so');
      /* JSON TEXT, not a live array. `QuestBoard._parseSteps` and its
       * `pre_steps` reader both call `JSON.parse` directly, so an array here
       * throws into their catch and draws a quest with no steps at all. */
      assert.equal(typeof r.steps, 'string', `${world}/${r.quest_number}: steps must be JSON text`);
      assert.ok(Array.isArray(JSON.parse(r.steps)), 'steps did not parse to an array');
      if (r.pre_steps !== null) {
        assert.equal(typeof r.pre_steps, 'string', 'pre_steps must be JSON text or null');
        assert.ok(Array.isArray(JSON.parse(r.pre_steps)));
      }
    }
  }
  assert.equal(total, SEED.length, 'the per-world lists do not add up to the whole seed');
});

test('an unknown or empty world yields nothing rather than throwing', () => {
  // The maze, space and the ten planets have no seeded quests, and
  // `QuestSystem` asks for the bundle by world id without checking first.
  for (const w of ['maze', 'space', 'cinder', '', null, undefined, 'NOT_A_WORLD']) {
    assert.deepEqual(offlineQuests(w), [], `world ${JSON.stringify(w)} returned rows`);
  }
});

test('a bundled id can never be mistaken for a database uuid', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set();
  for (const q of OFFLINE_QUESTS) {
    const id = offlineQuestId(q.quest_number);
    assert.ok(!uuid.test(id), `${id} looks like a randomUUID, which is what the quests table holds`);
    assert.ok(!seen.has(id), `${id} is not unique`);
    seen.add(id);
  }
});

/* ================================================================== */
/* 3. The reason the bundle exists at all                              */
/* ================================================================== */

test('the six authored worlds all have something on the board offline', () => {
  /* The defect this closes: signed out, or with no Next site behind
   * /api/game, the board drew "No quests in this category" in every world.
   * `Onboarding` records that first run happens signed out, so that was the
   * first thirty seconds of the game for every new player. */
  for (const world of ['station', 'medieval', 'sports', 'citadel', 'race', 'dock']) {
    const rows = offlineQuests(world);
    assert.ok(rows.length > 0, `${world} has no bundled quests, so its board is empty offline`);
    assert.ok(rows.every((r) => JSON.parse(r.steps).length > 0),
      `${world} bundles a quest with no steps, which can never be completed`);
  }
});
