import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadSeedQuests, resolveTarget, resolveQuestWorld, candidateValues, residentsFor,
  questManagersFor, rolesFor, spawnPlanFor, WORKING_STEP_TYPES, DEAD_STEP_TYPES,
  GATED_STEP_TYPES, UNGATED_STEP_TYPES, QUEST_GATE, VOCAB,
} from '../quest-vocab.mjs';

/**
 * The seeded quest content, measured against the engine's real vocabulary.
 *
 * ── The failure this file exists to make impossible ────────────────────────
 *
 * Two independent audits converged on the same verdict: 0 of 50 seeded quests
 * were completable, and roughly 6 of 184 steps could fire at all. The seed
 * invented ~150 target ids; the engine exposes ~40. The intersection was empty.
 * Grepping any seeded target string across the repo hit exactly two files —
 * `admin/lib/db.ts` and its copy in `admin/scripts/seed-quests.ts` — because
 * nothing in `src/` had ever heard of `relay_node`, `nightshade`, `grain_sack`
 * or `guild_master`.
 *
 * The content was not wrong in a way anyone could see. It read beautifully. It
 * was wrong in a way only a machine comparing two lists could see, and no
 * machine was comparing them. This test is that machine.
 *
 * ── The SECOND failure, which this ruler itself used to have ───────────────
 *
 * A name being DECLARED in `src/` does not mean a body carrying it ever gets a
 * spawn slot. `ROLE_CAST.station` — Quartermaster Bex, Broker Sunil Rai, Deck
 * Warden Ilse, Warden Cato Reyes — is handed out only by the crowd filler, and
 * the station leaves the filler TWO slots out of fifty. The same four names DO
 * spawn in `race`, which has no cast of its own and 23 slots spare. The old
 * vocabulary was global, so it accepted all four everywhere; content was
 * written against it and four station quests named people who are not there.
 *
 * That is "verified BUILT, never verified REACHABLE" — the exact defect class
 * the medieval expansion shipped four bugs through — living inside the tool
 * built to prevent it. The tests under "the spawn model" and "declared is not
 * spawned" below are the ones that close it, and they assert the KNOWN-BAD
 * cases fail, not merely that the good ones pass.
 *
 * ── This test FAILS on the current seed, and that is the point ─────────────
 *
 * It is the ruler, not the wall. Its output is written to be read by whoever
 * rewrites the content: every failure names the world, the quest number, the
 * step order, the offending value and the specific reason, grouped so a world
 * can be rewritten in one pass. A test that merely said "3 assertions failed"
 * would be worth nothing here.
 *
 * ── Why each rule is a rule ───────────────────────────────────────────────
 *
 *  1. TYPE      — five step types have no emitter anywhere in `src/`. A quest
 *                 containing one can never be completed by any player action.
 *  2. TARGET    — the id has to be something the engine can actually put on an
 *                 event, IN THE WORLD THE STEP NAMES, carried by something that
 *                 world actually spawns. See `quest-vocab.mjs`.
 *  3. COUNT     — `_advanceSteps` clamps `have` to `step.count`; a count below
 *                 1 completes on the first tick or never, neither on purpose.
 *  4. LENGTH    — 1 to 10 steps. Zero steps means `_checkQuestComplete` returns
 *                 early and the quest can never complete; past ten is a chore.
 *  5. ORDER     — `stepStates` is keyed by `order`, so a duplicate order makes
 *                 two steps share one state and a gap breaks the UI's ordering.
 *  6. PRE_STEPS — the accept route now enforces prerequisites (409 + missing[]).
 *                 A prerequisite naming a quest line that does not exist is a
 *                 quest nobody can ever accept.
 *  7. CYCLES    — a quest that requires itself, directly or through a chain, is
 *                 unacceptable forever and silently so.
 *  8. WORLD     — `_advanceSteps` skips any step whose `world` differs from the
 *                 world the PLAYER IS STANDING IN, so the id has to be a world
 *                 that exists. It does NOT have to be the quest's own world —
 *                 see "the FOURTH failure" below.
 *  9. REWARD    — the server re-reads `quests.reward_credits` and pays it. A
 *                 zero reward is a quest that pays nothing on completion.
 * 10. QUEST WORLD — a quest's OWN world must permit quests. That is a different
 *                 question from rule 8, and conflating them was this ruler's
 *                 THIRD false positive; see below.
 *
 * ── The THIRD failure: "cannot be accepted here" != "cannot advance here" ──
 *
 * The ruler used to reject every step scoped to a `quests: false` world, citing
 * MazeWorld's `quests: false`. Measurement in the running game killed that:
 * inside the maze, `rules.quests === false` and `worldQuests.length === 0` — and
 * an already-accepted `engagements.size === 1` whose maze-scoped `survive` step
 * still went `have 0 → 1 after 36 seconds`.
 *
 * The gate is ONE early return in `QuestSystem`'s `world:changed` handler. It
 * blanks the quest LIST, so no board and no accept; it never touches
 * `this.engagements`, and `_advanceSteps` consults no world rule at all. So:
 *
 *   • a QUEST's own world must permit quests — it needs a board (rule 10);
 *   • a STEP's world need not — it only has to be somewhere the type's emitter
 *     fires, and only `visit` fires from behind the gate.
 *
 * `GATED_STEP_TYPES` is derived from the engine, not listed: see
 * `readQuestGate` in `quest-vocab.mjs`. The test below asserts both halves —
 * `survive` scoped to the maze PASSES, and a quest whose own world IS the maze
 * FAILS — because a rule that only rejects is satisfied by rejecting
 * everything, which is how this ruler got it wrong the first time.
 *
 * ── The FOURTH failure: a rule that outlived the bug it was guarding ───────
 *
 * This ruler also used to reject EVERY step whose `world` differed from its
 * quest's `world`, on the stated grounds that "the quest is only listed on its
 * own world's board". That was a fair description of audit bug #7, and bug #7
 * was real: `_resolveQuestForEngagement` was `worldQuests.find(...) ?? null`, so
 * an engagement whose quest was authored in another world resolved to `null` on
 * reload. `_parseSteps(null)` is `[]`, which discarded the server's stored step
 * states, left `_advanceSteps` nothing to walk and made `_checkQuestComplete`
 * early-return on `!steps.length`. Cross-world quests really were unfinishable.
 *
 * BUG #7 IS FIXED. `_resolveQuestForEngagement` now falls back to
 * `_questFromEngagement`, which rebuilds the quest from the engagement's own
 * denormalised columns — `getPlayerQuestEngagements` LEFT JOINs `quests`, so
 * `quest_steps`, `quest_line` and `reward_credits` ride along on the row. Step
 * states rehydrate from the stored progress and the engagement advances
 * normally, whichever world the player reloads in. Verified by a 21/21 reload
 * simulation.
 *
 * So the cross-world rule is gone, because with #7 fixed it rejected exactly the
 * quests the game is supposed to have: a global line accepted at Zara Vex's desk
 * that sends the player to the citadel, the medieval world and the race and back
 * again. It flagged 35 steps across 5 quests, and every one of them works.
 *
 * What survives of it is the part that is still true:
 *
 *   • a STEP's `world` must be a REAL registered world id — `_advanceSteps`
 *     compares it against `this._worldId`, so a typo is a step that fires in no
 *     world at all. That is rule 8, and it is still enforced;
 *   • a QUEST's own `world` must permit quests — you can never accept a quest
 *     whose board does not exist. That is rule 10, and it never was rule 8;
 *   • `visit` is still gated (`GATED_STEP_TYPES`), so a `visit` step scoped to a
 *     `quests:false` world still fails — through `resolveTarget`, which is the
 *     rule that actually governs it, and not through a blanket world equality.
 *
 * `_advanceSteps` gates on `step.world` vs `this._worldId` and NEVER on
 * `entry.quest.world`. The test "a step's world is the PLAYER's world" below
 * asserts that against the engine's own source rather than trusting this
 * comment, so the rule cannot be reinstated by anyone who has not first changed
 * the engine back.
 */

const QUESTS = await loadSeedQuests();

/**
 * @typedef {{world:string, quest:number, title:string, order:number|null,
 *   rule:string, subject:string, reason:string}} Finding
 */

/* ---------------------------------------------------------------------- */
/* Collection                                                              */
/* ---------------------------------------------------------------------- */

/** @type {Finding[]} */
const FINDINGS = [];

/** @param {Finding} f */
const flag = (f) => { FINDINGS.push(f); return f; };

const questLines = new Set(QUESTS.map((q) => q.line));

for (const q of QUESTS) {
  const base = { world: q.world, quest: q.n, title: q.title };
  const steps = Array.isArray(q.steps) ? q.steps : [];

  /* 9. Reward. */
  if (!(Number(q.credits) > 0)) {
    flag({ ...base, order: null, rule: 'reward', subject: `reward_credits=${q.credits}`, reason: 'a completed quest must pay something' });
  }

  /* 10. The quest's OWN world has to have a board to list it on. A step may be
   *     scoped to a quest-less world; the quest itself may not live in one. */
  const qw = resolveQuestWorld(q.world);
  if (!qw.ok) {
    flag({ ...base, order: null, rule: 'quest-world', subject: `world="${q.world}"`, reason: qw.detail });
  }

  /* 4. Step count per quest. */
  if (steps.length < 1 || steps.length > 10) {
    flag({ ...base, order: null, rule: 'length', subject: `${steps.length} steps`, reason: 'quests must have between 1 and 10 steps' });
  }

  /* 5. Orders unique and contiguous from 1. */
  const orders = steps.map((s) => Number(s.order));
  const seen = new Set();
  for (const o of orders) {
    if (seen.has(o)) {
      flag({ ...base, order: o, rule: 'order', subject: `order=${o}`, reason: 'duplicate order — two steps would share one stepStates entry' });
    }
    seen.add(o);
  }
  const expected = steps.map((_, i) => i + 1);
  if (steps.length && orders.join(',') !== expected.join(',')) {
    flag({ ...base, order: null, rule: 'order', subject: `[${orders.join(',')}]`, reason: `orders must be contiguous from 1 — expected [${expected.join(',')}]` });
  }

  /* 6. Prerequisites name a real quest line. */
  for (const pre of (q.pre ?? [])) {
    if (!questLines.has(pre)) {
      flag({ ...base, order: null, rule: 'pre_steps', subject: `"${pre}"`, reason: 'no quest in the seed has this quest_line — the quest can never be accepted' });
    }
  }

  for (const s of steps) {
    const at = { ...base, order: Number(s.order) };
    const type = String(s.type ?? '');

    /* 3. Count. */
    if (!(Number(s.count) >= 1)) {
      flag({ ...at, rule: 'count', subject: `count=${s.count}`, reason: 'count must be at least 1' });
    }

    /* 8. Step world — it must EXIST. It need NOT be the quest's own world.
     *
     * `_advanceSteps` compares `step.world` against `this._worldId`, the world
     * the player is standing in, and consults `entry.quest.world` nowhere at
     * all. A station quest carrying a `world:'citadel'` step is therefore a
     * cross-world quest working as designed, not a defect — see "the FOURTH
     * failure" in the header, and the engine-source assertions below.
     *
     * What an unregistered id buys is a step that matches no world the player
     * can ever stand in, so it can never advance anywhere. Note the target is
     * judged against THIS world (`stepWorld ?? q.world`, rule 2 below), so a
     * cross-world step still has to name something that world can emit. */
    const stepWorld = s.world ?? null;
    if (stepWorld && !VOCAB.worlds[stepWorld]) {
      flag({ ...at, rule: 'world', subject: `world="${stepWorld}"`, reason: `not a registered World.static id (${Object.keys(VOCAB.worlds).join(', ')})` });
    }

    /* 1. Type. */
    if (DEAD_STEP_TYPES.includes(type)) {
      flag({ ...at, rule: 'dead-type', subject: `type="${type}"`, reason: 'no emitter anywhere in src/ — unfinishable by construction' });
      continue; // a dead type makes its target moot
    }
    if (!WORKING_STEP_TYPES.includes(type)) {
      flag({ ...at, rule: 'unknown-type', subject: `type="${type}"`, reason: `not one of ${WORKING_STEP_TYPES.join(', ')}` });
      continue;
    }

    /* 2. Target. */
    const res = resolveTarget(type, s.target, { world: stepWorld ?? q.world });
    if (!res.ok) {
      flag({ ...at, rule: res.reason, subject: `${type}:"${s.target}"`, reason: res.detail });
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Reporting                                                               */
/* ---------------------------------------------------------------------- */

/**
 * Group findings the way a rewrite happens: one world at a time, one quest at
 * a time, with the reason spelled out beside the value that caused it.
 * @param {Finding[]} list
 */
function report(list) {
  if (!list.length) return '';
  const byWorld = new Map();
  for (const f of list) {
    if (!byWorld.has(f.world)) byWorld.set(f.world, new Map());
    const byQuest = byWorld.get(f.world);
    if (!byQuest.has(f.quest)) byQuest.set(f.quest, []);
    byQuest.get(f.quest).push(f);
  }
  const lines = [''];
  for (const world of [...byWorld.keys()].sort()) {
    const byQuest = byWorld.get(world);
    const count = [...byQuest.values()].reduce((a, v) => a + v.length, 0);
    lines.push(`── ${world.toUpperCase()} — ${count} problem${count === 1 ? '' : 's'} across ${byQuest.size} quest${byQuest.size === 1 ? '' : 's'} ──`);
    for (const n of [...byQuest.keys()].sort((a, b) => a - b)) {
      const items = byQuest.get(n);
      lines.push(`  Q${String(n).padStart(2, ' ')}  ${items[0].title}`);
      for (const f of items) {
        const where = f.order == null ? 'quest ' : `step ${f.order}`;
        lines.push(`        ${where}  [${f.rule}] ${f.subject}`);
        lines.push(`                    ${f.reason}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Findings for one rule (or set of rules), plus their report. */
function forRules(...rules) {
  const list = FINDINGS.filter((f) => rules.includes(f.rule));
  return { list, text: report(list) };
}

/** Assert a target resolves, with the vocabulary's own reason on failure. */
function ok(type, target, world, why) {
  const r = resolveTarget(type, target, { world });
  assert.equal(r.ok, true, `${type}:"${target}" in ${world} SHOULD resolve — ${why}\n  got: ${r.reason} — ${r.detail}`);
  return r;
}

/** Assert a target does NOT resolve. The reason text is part of the contract. */
function rejects(type, target, world, why) {
  const r = resolveTarget(type, target, { world });
  assert.equal(r.ok, false, `${type}:"${target}" in ${world} MUST be rejected — ${why}\n  but it matched ${r.matched?.kind} "${r.matched?.value}" (${r.matched?.source})`);
  return r;
}

/* ---------------------------------------------------------------------- */
/* The vocabulary itself must not silently collapse                        */
/* ---------------------------------------------------------------------- */

test('the vocabulary derives real values from the real source files', () => {
  // A broken scraper would report an EMPTY vocabulary, and an empty vocabulary
  // rejects everything — which looks like a content failure and is not one.
  // These floors are deliberately far below the current numbers: they catch a
  // scrape that has stopped working, not one that has merely shifted.
  assert.ok(VOCAB.items.length >= 20, `only ${VOCAB.items.length} items derived from ItemDefs.ITEMS`);
  assert.ok(VOCAB.circuits.length >= 3, `only ${VOCAB.circuits.length} circuits derived from RaceCircuits.CIRCUITS`);
  assert.equal(VOCAB.roles.length, 7, 'ROLE lost or gained an entry — check NPCRoles.js');
  assert.ok(Object.keys(VOCAB.worlds).length >= 7, 'fewer than seven World subclasses found');
  assert.ok(VOCAB.roleRotation.length >= 6, 'ROLE_ROTATION scrape collapsed — check NPCRoles.js');

  const qm = VOCAB.questManagers;
  for (const world of ['station', 'medieval', 'sports', 'citadel', 'race']) {
    assert.ok(qm[world], `no quest manager scraped for ${world} — NPCManager._spawnQuestManagers changed shape`);
  }
  for (const world of ['station', 'medieval', 'sports', 'citadel', 'race']) {
    const w = VOCAB.worlds[world];
    assert.ok(w.friendlyNames.length >= 4, `${world} yielded only ${w.friendlyNames.length} named NPCs — the cast scraper has stopped working`);
  }

  // The engine's own numbers, scraped rather than copied.
  const L = VOCAB.spawnLimits;
  for (const [key, value] of Object.entries(L)) {
    assert.ok(Number.isFinite(value) && value > 0, `spawn limit ${key} did not scrape (${value})`);
  }
  assert.ok(Object.keys(VOCAB.dropTables).length >= 3, 'DROP_TABLES scrape collapsed — check Loot.js');
  assert.ok(Object.keys(VOCAB.cacheTables).length >= 3, 'CACHE_TABLES scrape collapsed — check Caches.js');
  assert.ok((VOCAB.stashTiers.common ?? []).length >= 1, 'Interiors._contentsFor scrape collapsed');
});

test('every quest-enabled world can actually satisfy the types content uses', () => {
  // Guards the ruler from the opposite mistake: a world where a working type
  // has zero candidates would fail every step of that type for a reason that
  // is about the engine, not the content.
  for (const world of VOCAB.questWorlds) {
    for (const type of ['visit', 'collect', 'talk', 'interact', 'survive']) {
      const n = candidateValues(type, world).length;
      assert.ok(n > 0, `${world} has no reachable "${type}" targets at all`);
    }
  }
});

/* ---------------------------------------------------------------------- */
/* The spawn model — the blind spot this ruler used to have                */
/* ---------------------------------------------------------------------- */

test('the spawn model reproduces NPCManager.spawnForWorld arithmetic', () => {
  /* The model is only EXACT while two things hold, so both are asserted rather
   * than assumed. If either stops holding the numbers below become estimates
   * and the vocabulary would be guessing, which is what it exists not to do. */
  for (const id of VOCAB.questWorlds) {
    const plan = spawnPlanFor(id);
    assert.equal(plan.authoredDropped, 0,
      `${id} authors ${plan.authored} friendlies against an authoredCap of ${plan.authoredCap}: `
      + `${plan.authoredDropped} of them are silently dropped by spawnForWorld, and which ones depends on `
      + 'npcSpawns ORDER, which this scrape only approximates. Raise friendlyBudget or cut the cast.');
    assert.equal(plan.overCeiling, false,
      `${id} plans ${plan.bodies} bodies against maxNPCs ${VOCAB.spawnLimits.maxNPCs} — spawnForWorld would `
      + 'start dropping characters and no name in this world could be trusted.');
  }

  /* The station is the world the blind spot was found in, so it is the one
   * pinned to its arithmetic. Each number is derived, none is typed twice. */
  const station = spawnPlanFor('station');
  assert.equal(station.friendlyBudget, 50, 'StationWorld.friendlyBudget scrape moved');
  assert.equal(station.authoredSpawned, 42, 'the station cast scrape moved (18 hub + 6 per zone x 4)');
  assert.equal(station.lorekeepers, 6, 'the station has six gateways, hence six lorekeepers');
  assert.equal(
    station.fillerSlots,
    station.friendlyBudget - station.authoredSpawned - station.lorekeepers,
    'filler budget is the RESIDUAL of friendlyBudget, not a number of its own',
  );
  assert.equal(station.fillerSlots, 2, 'the station leaves _populateHubs two slots');

  // Which is less than one rotation, so no filler name is trusted there...
  assert.ok(station.fillerSlots < VOCAB.fillerCycle,
    'the station filler no longer sits under a full ROLE_ROTATION cycle — re-check the cast rules below');
  // ...whereas race has budget to spare, which is why the same names work there.
  const race = spawnPlanFor('race');
  assert.ok(race.fillerSlots >= VOCAB.fillerCycle,
    `race leaves the filler only ${race.fillerSlots} slots — its ROLE_CAST names are no longer dependable either`);
});

test('declared in source is NOT spawns in game — ROLE_CAST names are per-world', () => {
  /* The four names the content agents were told were valid station targets.
   * They are handed out ONLY by `_populateHubs`, and the station's residual is
   * two slots — so they are unreachable there and reachable in `race`, which
   * falls back to the same cast with 23 slots spare. Both halves are asserted:
   * a rule that only rejects would be satisfied by rejecting everything. */
  const CAST = ['Quartermaster Bex', 'Broker Sunil Rai', 'Deck Warden Ilse', 'Warden Cato Reyes'];
  for (const name of CAST) {
    rejects('talk', name, 'station',
      'ROLE_CAST.station is crowd-filler-only and the station has 2 filler slots against a 12-slot rotation');
    ok('talk', name, 'race',
      'race has no cast of its own, falls back to ROLE_CAST.station, and leaves the filler 23 slots');
  }

  // And the derived lists agree with the individual answers.
  const stationNames = new Set(residentsFor('station').map((r) => r.name));
  const raceNames = new Set(residentsFor('race').map((r) => r.name));
  for (const name of CAST) {
    assert.equal(stationNames.has(name), false, `${name} must not be a station resident`);
    assert.equal(raceNames.has(name), true, `${name} must be a race resident`);
  }
});

test('roles are per-world: the station has no guard, and no spectator or loiterer either', () => {
  const stationRoles = rolesFor('station');
  assert.deepEqual([...stationRoles].sort(), ['lorekeeper', 'quest_manager', 'vendor', 'wanderer'],
    'every authored role: in StationWorld.js and station/zones/*.js is vendor or quest_manager; '
    + 'wanderer is the default for an unroled friendly and lorekeeper comes from the six gateways');

  for (const role of ['guard', 'spectator', 'loiterer']) {
    const r = rejects('talk', role, 'station', `no station NPC carries the role "${role}"`);
    assert.match(r.detail, /carries the role/, 'the failure must say WHY, not just "unknown target"');
  }
  for (const role of ['vendor', 'wanderer']) {
    ok('talk', role, 'station', 'the station authors vendors and defaults every other friendly to wanderer');
  }
  // `guard` is real somewhere — the rule is per-world, not a blanket ban.
  ok('talk', 'guard', 'race', 'race has 23 filler slots, and ROLE_ROTATION[2] is guard');
  ok('talk', 'guard', 'medieval', 'medieval/Population.js roleOrder pushes guards into every settlement');
});

test('interact is quest-manager-only; every other NPC must use talk', () => {
  /* HUD.js:1772 branches on `npc.isQuestManager`: a quest desk emits `interact`
   * and opens the board, everything else emits `talk`. A step that names the
   * wrong one can never advance, and the audit was wrong in BOTH directions
   * about who is which — it believed interact worked only on the five
   * NPCManager managers, when the station authors five more of its own. */
  const desks = questManagersFor('station');
  assert.equal(desks.length, 6,
    `the station has six quest desks, not ${desks.length} — Zara Vex plus five authored `
    + `(${desks.join(', ')}). NPCManager.js:742 honours isQuestManager on any spawn spec.`);
  assert.ok(desks.includes('Zara Vex'), 'NPCManager._spawnQuestManagers plants Zara Vex');
  assert.ok(desks.includes('Dispatcher Ovie Kanu'), 'StationWorld authors a second desk on the strip');

  // KNOWN-GOOD
  ok('interact', 'Zara Vex', 'station', 'the NPCManager cast desk');
  ok('interact', 'Dispatcher Ovie Kanu', 'station', 'an authored isQuestManager: true spawn');
  ok('interact', 'quest_manager', 'station', 'the role is on the event too');

  // KNOWN-BAD, both directions, for EVERY station NPC rather than a sample.
  for (const r of residentsFor('station')) {
    if (r.questManager) {
      const bad = rejects('talk', r.name, 'station', `${r.name} is a quest manager, so E emits interact`);
      assert.match(bad.detail, /must use type "interact"/, 'the failure must name the fix');
    } else {
      const bad = rejects('interact', r.name, 'station', `${r.name} is not a quest manager, so E emits talk`);
      assert.match(bad.detail, /must use type "talk"/, 'the failure must name the fix');
      ok('talk', r.name, 'station', 'an ordinary NPC is a valid talk target');
    }
  }
});

/* ====================================================================== */
/* Purchase steps against the VENDOR's stock, not just the catalogue       */
/* ====================================================================== */

/**
 * Every marketplace row's category, and the game item id it grants.
 *
 * Scraped, like everything else in this ruler, because the two ends live in
 * different languages: the categories are in `site/lib/marketplaceCatalog.ts`
 * and the vendor restrictions are `vendorCategories` arrays inside world files.
 * Nothing in `src/` joins them, which is exactly why the join has to be made
 * here.
 */
function catalogueRows() {
  const src = readFileSync(new URL('../../site/lib/marketplaceCatalog.ts', import.meta.url), 'utf8');
  const rows = [];
  const re = /source_key:\s*'([^']+)'[\s\S]{0,700}?category:\s*'([a-z]+)'/g;
  for (const m of src.matchAll(re)) {
    const tail = src.slice(m.index, m.index + 900);
    const ammo = /ammo_item:\s*'([^']+)'/.exec(tail);
    rows.push({ key: m[1], category: m[2], item: ammo ? ammo[1] : null });
  }
  return rows;
}

/** `vendorCategories` authored per world, one entry per counter. */
function vendorStockFor(worldFile) {
  const src = readFileSync(new URL(`../../src/worlds/${worldFile}`, import.meta.url), 'utf8');
  const out = [];
  for (const m of src.matchAll(/vendorCategories:\s*\[([^\]]*)\]/g)) {
    out.push([...m[1].matchAll(/'([a-z]+)'/g)].map((c) => c[1]));
  }
  return out;
}

test('a purchase step must name goods a vendor in that world actually stocks', () => {
  /* THE DEFECT this half can see. Drop Two gave the citadel three counters and
   * gave each one a `vendorCategories` list. `Marketplace.refreshCatalog`
   * filters `_catalog` itself by that list, so a category no counter in the
   * world stocks is a purchase step nobody can complete anywhere on the map.
   * The previous ruler validated a purchase target against the ITEM catalogue
   * and never against the counters, which is why it was green.
   *
   * ── AND THE HALF A MACHINE CANNOT READ ─────────────────────────────────
   * The citadel's three counters cover the whole catalogue between them, so
   * the assertion below passes for every citadel step - and the shipped defect
   * was still real, because `_findVendor` only sees NPCs inside `VENDOR_RANGE`
   * = 7 m (measured: Rafiq 19.7 m from Hafsa's stall, Bashir 34.2 m) and three
   * steps sent the player to HER stall for a `medkit` (`health`, Rafiq) and an
   * `arrow` (`weapons`, Bashir). What was wrong was the LABEL, and the worst
   * of the three said "stand within a few paces of her stall" - a pronoun
   * pointing back at the previous step. No regex over prose can be trusted to
   * catch that without failing honest labels that name a counter in order to
   * say it is the wrong one. That half is guarded by the ⚠ in
   * `admin/lib/quests/citadel.mjs`'s header and by review, not by this file.
   */
  const rows = catalogueRows();
  assert.ok(rows.length >= 20, `the marketplace catalogue scrape collapsed: ${rows.length} rows`);
  assert.ok(rows.some((r) => r.key === 'pack_medkit' && r.category === 'health'),
    'the scrape lost pack_medkit/health - the regex no longer matches the catalogue');

  /* Worlds that RESTRICT. A world whose counters author no `vendorCategories`
   * is a general trader and this test has nothing to say about it. */
  const restricted = {
    citadel: 'CitadelWorld.js', station: 'StationWorld.js', race: 'RaceWorld.js',
    /* Lodestar Yard restricts hard: three counters split the whole catalogue
     * three ways, including the `ships` tab nowhere else has. Without the row
     * here every `purchase` step in a dock quest goes unchecked - which is the
     * silent half, and the same silence that let a citadel quest send a player
     * to a cloth stall for a medkit. */
    dock: 'DockWorld.js',
  };
  let checked = 0;
  for (const [world, file] of Object.entries(restricted)) {
    const stock = vendorStockFor(file);
    assert.ok(stock.length, `${file} authors no vendorCategories any more - drop it from this list`);
    const stocked = new Set(stock.flat());
    for (const q of QUESTS) {
      for (const s of q.steps ?? []) {
        if (s.type !== 'purchase') continue;
        if ((s.world ?? resolveQuestWorld(q)) !== world) continue;
        // A trade KIND (`buy`/`sell`) is not a row in any catalogue, and
        // selling is not category-gated: `Marketplace.sellables` reads the
        // player's own bag.
        const want = rows.filter((r) => r.key === s.target || r.item === s.target
          || r.key.split('_').includes(s.target));
        if (!want.length) continue;
        checked++;
        const cats = [...new Set(want.map((r) => r.category))];
        assert.ok(cats.some((c) => stocked.has(c)),
          `Q${q.n} step ${s.order}: "${s.target}" is category ${cats.join('/')} and no ${world} counter `
          + `stocks it - the counters between them sell ${[...stocked].sort().join(', ')}`);
      }
    }
  }
  assert.ok(checked >= 3, `only ${checked} purchase steps resolved to a catalogue row - the join is vacuous`);
});

test('collect targets must be obtainable in the world that names them', () => {
  /* Three sources and no others: corpse drops (which need hostiles), caches,
   * and authored interior stashes. `DROP_TABLES` has station/medieval/sports
   * entries; citadel falls back to the station table and race authors no
   * hostiles at all, so nothing in race can ever drop. */
  const race = VOCAB.worlds.race;
  assert.equal(race.hostileNames.length, 0, 'race authors no hostiles');
  assert.equal(race.unnamedHostiles, false, 'race authors no nameless hostiles either');

  for (const item of ['credits', 'arrow', 'fireball_charge']) {
    const r = rejects('collect', item, 'race',
      'race has no hostiles, so no corpse drop; its caches fall back to the station table');
    assert.match(r.detail, /the world yields/, 'the failure must list what the world DOES yield');
  }
  ok('collect', 'bullet', 'race', 'the station cache table is the race fallback and stocks bullets');
  ok('collect', 'relic_coin', 'race', 'RaceWorld authors an interior stash, and a common stash is a relic coin');

  /* Citadel: it HAS a drop table of its own now, and the whole point of that
   * table is what it refuses to contain. While it fell back to the station's,
   * a quest could ask a player to collect rifle rounds and hull plate on a
   * mesa that manufactures neither, and two shipped steps did exactly that. */
  ok('collect', 'relic_coin', 'citadel', 'DROP_TABLES.citadel and CACHE_TABLES.citadel both stock relic_coin');
  ok('collect', 'arrow', 'citadel', 'arrows are the local ammunition, from bodies and from caches alike');
  assert.ok(VOCAB.dropTables.citadel, 'DROP_TABLES.citadel went away again — the station fallback is back');
  for (const gone of ['bullet', 'fireball_charge', 'alloy_scrap']) {
    const r = rejects('collect', gone, 'citadel',
      'a station item the citadel only ever yielded through the DROP_TABLES fallback');
    assert.match(r.detail, /the world yields/, 'the failure must list what the world DOES yield');
  }

  // Shop-only goods are in ITEMS and in no table anywhere: unobtainable by
  // collecting, in every world.
  for (const world of VOCAB.questWorlds) {
    rejects('collect', 'speed_boost_25', world, 'no drop, cache or stash table anywhere contains it');
    rejects('collect', 'loot_magnet_30s', world, 'no drop, cache or stash table anywhere contains it');
  }
});

test('a target cannot be judged without a world', () => {
  /* The whole point of the rebuild. A world-less answer is how "Quartermaster
   * Bex" came to be a station target: she is real, in another world. */
  const r = resolveTarget('talk', 'Quartermaster Bex', {});
  assert.equal(r.ok, false, 'resolveTarget must refuse to answer without a world');
  assert.equal(r.reason, 'no-world');
  assert.equal(candidateValues('talk', null).length, 0, 'there is no world-independent vocabulary');
});

test('race steps only resolve where a world publishes a trackPath', () => {
  ok('race', 'vellum', 'race', 'RaceWorld publishes trackPath and RaceCircuits declares vellum');
  const r = rejects('race', 'vellum', 'sports', 'SportsWorld publishes no trackPath, so RaceManager.arm() bails');
  assert.equal(r.reason, 'no-candidates');
  assert.equal(VOCAB.worlds.sports.publishesTrack, false, 'sports still has no track');
  assert.equal(VOCAB.worlds.race.publishesTrack, true, 'race still has one');
});

test('minigame steps resolve only where a registered venue hosts the game', () => {
  /* The derivation floors first: an empty scrape rejects everything, which
   * would read as a content failure and be a validator one. Three files have
   * to agree for a game to exist — the world's `minigameVenues` descriptor,
   * `main.js`'s registerGame call, and the module's GAME_ID export — and the
   * scrape reads all three, so each is pinned here. */
  const games = VOCAB.minigames.games;
  assert.equal(games.swim, 'swim_challenge', 'SwimChallenge.js SWIM_GAME_ID scrape moved');
  assert.equal(games.ski, 'ski_slalom', 'SkiRun.js SKI_GAME_ID scrape moved');
  assert.equal(games.tennis, 'tennis_match', 'TennisMatch.js TENNIS_GAME_ID scrape moved');
  assert.equal(games.run, 'track_race', 'TrackRace.js TRACK_GAME_ID scrape moved');
  const sportsVenues = VOCAB.minigames.venuesByWorld.sports ?? [];
  assert.deepEqual(sportsVenues.map((v) => v.id).sort(),
    ['lido_pool', 'meridian_court', 'meridian_slope', 'meridian_track'],
    'the SportsWorld.minigameVenues scrape no longer finds the four venues');

  /* `minigame` arrives as a bus event (`quest:activity` → `_onActivity`), so
   * the quests:false gate cannot touch it. That classification is CONFIRMED
   * against the derivation, not asserted by hand: readQuestGate finds no
   * literal _advanceSteps('minigame') call site to sit behind the gate, so the
   * type lands in the ungated set on its own. */
  assert.ok(UNGATED_STEP_TYPES.includes('minigame'),
    'minigame must derive as UNGATED — its emitter is a bus subscription, and the gate only reaches literal call sites');
  assert.equal(GATED_STEP_TYPES.includes('minigame'), false,
    'minigame must never derive as gated');

  /* KNOWN-GOOD, in the one world whose venues host the games. The bare game
   * id is deliberately NOT an engine candidate (it would complete "win it"
   * steps on a loss, as a token-subrun of the composite) — it matches
   * THROUGH the `_won`/`_lost` composites, and this asserts that path works. */
  ok('minigame', 'tennis_match', 'sports', 'any finish — the game id is a token run inside both composites');
  ok('minigame', 'tennis_match_won', 'sports', 'the win composite is offered exactly, on a won finish');
  ok('minigame', 'swim_challenge', 'sports', 'any finish of the lido challenge');
  ok('minigame', 'swim_challenge_won', 'sports', 'a won swim, and only a won one');
  ok('minigame', 'ski_slalom_won', 'sports', 'a won slalom, and only a won one');
  ok('minigame', 'Lido Swim Challenge', 'sports', 'the venue label rides on the event as `name`');
  ok('minigame', 'meridian_court', 'sports', 'the venue id rides on the event as `venueId`');
  ok('minigame', 'won', 'sports', 'the last token of every win composite');
  ok('minigame', 'place_1', 'sports', 'a minigame win is first place, in the namespaced spelling');

  /* KNOWN-BAD. The same real game in a world with no venue must fail for the
   * world reason — nothing there can emit the event — and a game nobody wrote
   * must fail everywhere, including where the emitter exists. */
  const away = rejects('minigame', 'tennis_match', 'medieval',
    'no medieval venue hosts tennis — the vale publishes no minigameVenues at all');
  assert.equal(away.reason, 'no-candidates',
    'the failure must say the world cannot emit a minigame event, not merely "unknown target"');
  for (const world of VOCAB.questWorlds) {
    rejects('minigame', 'poker_night', world, 'no such game is registered anywhere');
  }
});

/* ---------------------------------------------------------------------- */
/* quests:false gates the BOARD, not the engagement                        */
/* ---------------------------------------------------------------------- */

test('the quests gate is derived from QuestSystem, not listed here', () => {
  /* If this scrape collapses it would silently return an EMPTY gated set,
   * which accepts everything — the opposite failure to the one being fixed and
   * just as invisible. So the derivation's own workings are asserted. */
  assert.ok(QUEST_GATE.controlled.length >= 1,
    'the quests gate was found to control no state at all — readQuestGate has stopped working');
  assert.deepEqual([...QUEST_GATE.clears], ['worldQuests'],
    'the gate blanks the quest LIST and nothing else — that is the whole of what quests:false does');
  assert.ok(QUEST_GATE.gatedMethods.includes('_creditVisit'),
    '_creditVisit must resolve as reachable only through the gate');

  assert.deepEqual([...GATED_STEP_TYPES], ['visit'],
    'visit is the only type credited from behind the allows(world, "quests") early return: '
    + '_creditVisit is called from the handler after the gate, from accept() (which looks in the '
    + 'emptied worldQuests) and from _loadQuestsForWorld (reached only via the skipped _pending flag)');

  // survive is credited from update(), which no world rule touches.
  assert.ok(UNGATED_STEP_TYPES.includes('survive'),
    'survive is credited by the update() timer, not by the world:changed handler');
  for (const type of WORKING_STEP_TYPES) {
    assert.equal(GATED_STEP_TYPES.includes(type) || UNGATED_STEP_TYPES.includes(type), true,
      `${type} is in neither set — the partition has a hole`);
  }
});

test('a step may be scoped to a quests:false world; a QUEST may not live in one', () => {
  const maze = VOCAB.worlds.maze;
  assert.ok(maze, 'MazeWorld is still a registered world');
  assert.equal(maze.rules.quests, false, 'MazeWorld still sets quests:false');
  assert.equal(VOCAB.questWorlds.includes('maze'), false, 'no quest board in the maze');
  assert.equal(VOCAB.stepWorlds.includes('maze'), true, 'a step may still be scoped to the maze');

  /* MEASURED in the running game: world = maze, rules.quests === false,
   * worldQuests.length === 0, engagements.size === 1, and the survive step went
   * have 0 → 1 after 36 s. The ruler has to agree with the game. */
  ok('survive', 'maze', 'maze',
    '_creditSurvive is called from update(), which is not rule-gated, and the engagement survives the world change');

  // visit is the one that really cannot: its credit is behind the gate.
  const dead = rejects('visit', 'maze', 'maze',
    '_creditVisit is only reached after the allows(world, "quests") early return');
  assert.equal(dead.reason, 'quests-disabled');
  assert.match(dead.detail, /_creditVisit/, 'the failure must name the method that cannot run');

  // And the quest itself can never be offered there, however live its steps are.
  const board = resolveQuestWorld('maze');
  assert.equal(board.ok, false, 'a quest whose own world is the maze reaches no board');
  assert.equal(board.reason, 'quest-world');
  assert.match(board.detail, /quests:false/, 'the failure must name the rule');
  for (const world of VOCAB.questWorlds) {
    assert.equal(resolveQuestWorld(world).ok, true, `${world} permits quests, so a quest may live there`);
  }
  assert.equal(resolveQuestWorld('nowhere').ok, false, 'an unregistered world is not a board either');

  /* The relaxation is only of the QUEST rule. Everything the maze itself
   * forbids is still forbidden, by the rule that forbids it — so this is not a
   * blanket "the maze accepts anything". */
  for (const [type, why] of [
    ['collect', 'MazeWorld sets loot:false, caches:false and interiors:false — no pickup exists'],
    ['kill', 'MazeWorld sets hostiles:false'],
    ['defend', 'MazeWorld sets hostiles:false'],
    ['purchase', 'MazeWorld sets merchants:false'],
    ['race', 'MazeWorld sets races:false and publishes no trackPath'],
  ]) {
    const r = rejects(type, '', 'maze', why);
    assert.equal(r.reason, 'no-candidates',
      `${type} must be refused for the rule that governs it, not for the quest rule — got ${r.reason}`);
  }
});

/* ---------------------------------------------------------------------- */
/* A step's world is the PLAYER's world, never the quest's                 */
/* ---------------------------------------------------------------------- */

const ENGINE = readFileSync(new URL('../../src/systems/QuestSystem.js', import.meta.url), 'utf8');

/** Strip comments, so an assertion about CODE cannot be satisfied by prose. */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/**
 * One method's body, by brace matching from its declaration.
 *
 * The parameter list is walked FIRST and separately: `_advanceSteps(type,
 * filter, meta = {})` has a default of `{}`, so taking the first `{` after the
 * name returns an empty body — which matches nothing and passes every
 * `assert.equal(..., false)` for the wrong reason.
 *
 * @param {string} name
 */
function methodBody(name) {
  const at = ENGINE.indexOf(`\n  ${name}(`);
  assert.ok(at >= 0, `${name} is no longer a method of QuestSystem — this test needs rewriting`);

  const run = (from, [open, close]) => {
    let depth = 0;
    for (let i = ENGINE.indexOf(open, from); i < ENGINE.length; i += 1) {
      if (ENGINE[i] === open) depth += 1;
      else if (ENGINE[i] === close) {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return assert.fail(`${name} has no closing ${close}`);
  };

  const endOfParams = run(at, ['(', ')']);
  const bodyOpen = ENGINE.indexOf('{', endOfParams);
  const bodyClose = run(endOfParams, ['{', '}']);
  const body = ENGINE.slice(bodyOpen, bodyClose + 1);
  assert.ok(body.length > 2, `${name} came back with an empty body — the scrape is broken`);
  return body;
}

test('a step\'s world is the PLAYER\'s world, not the quest\'s — bug #7 is fixed', () => {
  /* The rule this replaces rejected every step whose world differed from its
   * quest's, citing "the quest is only listed on its own world's board". That
   * described audit bug #7, which is fixed. A comment cannot stop the rule being
   * reinstated, so the two engine facts it depended on are asserted against the
   * engine's own source — reinstating the rule now requires changing the engine
   * back first, which is exactly the order those two decisions belong in. */

  const advance = codeOf(methodBody('_advanceSteps'));
  assert.match(advance, /step\.world\s*&&\s*step\.world\s*!==\s*worldId/,
    '_advanceSteps must gate on the STEP\'s world against the world the player is in');
  assert.equal(/quest\??\.world/.test(advance), false,
    '_advanceSteps must never consult the QUEST\'s world. Gating there would silently make '
    + 'every global quest finishable only in the world that happens to host its board.');

  /* Bug #7 itself: an engagement whose quest is not in `worldQuests` used to
   * resolve to null, so `_parseSteps(null)` gave [] and the stored progress was
   * thrown away. It is now rebuilt from the engagement's own columns. */
  const resolve = codeOf(methodBody('_resolveQuestForEngagement'));
  assert.match(resolve, /_questFromEngagement\(eng\)/,
    '_resolveQuestForEngagement must fall back to a rebuilt quest, never to null — a null here '
    + 'is bug #7 back again, and it draws as a blank, permanently stuck row on the board');

  const rebuilt = codeOf(methodBody('_questFromEngagement'));
  assert.match(rebuilt, /steps:\s*eng\?\.quest_steps/,
    'the rebuilt quest must carry quest_steps — without them stepStates cannot rehydrate, '
    + '_advanceSteps has nothing to walk and _checkQuestComplete early-returns');
  assert.match(rebuilt, /world:\s*eng\?\.world/,
    'and its own world, copied from quests.world at accept time');

  /* And the vocabulary agrees: a step scoped to another world is judged by THAT
   * world, so a station quest may legitimately ask for something only the
   * citadel can provide — while still being refused anything it cannot. */
  ok('collect', 'relic_coin', 'citadel', 'a station-boarded quest may send the player to the citadel');
  ok('kill', 'sentinel', 'citadel', 'and ask for the one thing only the citadel spawns');
  rejects('kill', 'sentinel', 'race', 'cross-world does not mean unchecked — race authors no hostiles');
});

/* ---------------------------------------------------------------------- */
/* The content rules                                                       */
/* ---------------------------------------------------------------------- */

test('1. no step uses a type that has no emitter', () => {
  const { list, text } = forRules('dead-type', 'unknown-type');
  assert.equal(list.length, 0,
    `${list.length} step(s) use a type no player action can advance.\n`
    + `Types with an emitter: ${WORKING_STEP_TYPES.join(', ')}\n`
    + `Types with NO emitter: ${DEAD_STEP_TYPES.join(', ')}\n${text}`);
});

test('2. every step target resolves against the engine vocabulary', () => {
  const { list, text } = forRules('unknown-target', 'no-candidates', 'unknown-world', 'quests-disabled', 'no-world');
  const world = (id) => VOCAB.worlds[id];
  const hint = [
    '',
    'What a target MAY be, by step type — PER WORLD, because the engine is:',
    `  visit / survive  the step's own world id — ${VOCAB.questWorlds.join(', ')}`,
    '  collect          an item that world can actually put in a pickup:',
    ...VOCAB.questWorlds.map((id) => `                     ${id.padEnd(9)} ${world(id).collectables.join(', ') || '(nothing)'}`),
    '  talk             an NPC that SPAWNS in that world and is NOT a quest manager,',
    '                   or a role some NPC there carries:',
    ...VOCAB.questWorlds.map((id) => `                     ${id.padEnd(9)} ${world(id).reachableRoles.join(', ')}`),
    '  interact         a portal id (`station->medieval`), a destination world, or a',
    '                   QUEST MANAGER — every other NPC emits talk, not interact:',
    ...VOCAB.questWorlds.map((id) => `                     ${id.padEnd(9)} ${world(id).questManagers.join(', ')}`),
    '  kill / defend    a hostile that world authors, or `sentinel` where it authors',
    '                   nameless ones, or empty for any',
    `  race             a circuit (${VOCAB.circuits.map((c) => c.id).join(', ')}), a race type`,
    `                   (${VOCAB.raceTypes.join(', ')}), or a placing (place_1, p1, 1st, first)`,
    '                   — and ONLY where a world publishes a trackPath, which is race alone',
    '  purchase         an item id, a pack id, or `buy`/`sell`, where a vendor exists',
    '  customize        a character field value (outfit, hairStyle, headgear, sex, build)',
    '  minigame         a venue label or venue id, a `<gameId>_won`/`<gameId>_lost`',
    '                   composite (or the bare game id / kind / won / lost, which match',
    '                   THROUGH the composites), or a win place token — only where the',
    '                   world publishes a minigameVenues entry whose kind main.js',
    '                   registers a module for, which today is sports alone:',
    ...Object.entries(VOCAB.minigames.venuesByWorld)
      .filter(([, v]) => v.length)
      .map(([id, v]) => `                     ${id.padEnd(9)} ${v.map((x) => `${x.gameId} (${x.id})`).join(', ')}`),
    '',
    'A name being written down in src/ is NOT enough. It has to get a spawn slot in',
    'the world the step names — see the spawn model tests above.',
    '',
    `A step may be scoped to ANY world (${VOCAB.stepWorlds.join(', ')}), not only the ones with a`,
    'quest board: quests:false blanks the quest LIST on entry, but an already-accepted',
    `engagement keeps advancing. ${UNGATED_STEP_TYPES.join(', ')} still fire there;`,
    `${GATED_STEP_TYPES.join(', ')} cannot, because it is credited from behind the gate.`,
    '',
  ].join('\n');
  assert.equal(list.length, 0,
    `${list.length} step target(s) name something the engine can never emit.${hint}${text}`);
});

test('3. every step counts at least once', () => {
  const { list, text } = forRules('count');
  assert.equal(list.length, 0, `${list.length} step(s) have an unusable count.\n${text}`);
});

test('4. every quest has between 1 and 10 steps', () => {
  const { list, text } = forRules('length');
  assert.equal(list.length, 0, `${list.length} quest(s) are outside the 1-10 step range.\n${text}`);
});

test('5. step orders are unique and contiguous from 1', () => {
  const { list, text } = forRules('order');
  assert.equal(list.length, 0, `${list.length} quest(s) have a broken step order.\n${text}`);
});

test('6. every pre_steps entry names a quest line that exists', () => {
  const { list, text } = forRules('pre_steps');
  assert.equal(list.length, 0,
    `${list.length} prerequisite(s) name a quest line no quest provides.\n`
    + `Known quest lines: ${[...questLines].sort().join(', ')}\n${text}`);
});

test('7. no quest requires itself, directly or through a chain', () => {
  /* Prerequisites are named by quest_line, and a line may in principle be
   * shared, so the graph is over lines rather than quest numbers. A cycle here
   * is invisible in the admin UI and permanently unacceptable in game — the
   * accept route answers 409 forever with a `missing[]` that can never empty. */
  const pre = new Map();
  for (const q of QUESTS) {
    const list = pre.get(q.line) ?? [];
    for (const p of (q.pre ?? [])) if (!list.includes(p)) list.push(p);
    pre.set(q.line, list);
  }

  /** @type {string[][]} */
  const cycles = [];
  const state = new Map(); // line → 'open' | 'done'
  const walk = (line, path) => {
    if (state.get(line) === 'done') return;
    if (state.get(line) === 'open') {
      cycles.push([...path.slice(path.indexOf(line)), line]);
      return;
    }
    state.set(line, 'open');
    for (const next of (pre.get(line) ?? [])) {
      if (!pre.has(next)) continue; // rule 6 reports the dangling reference
      walk(next, [...path, line]);
    }
    state.set(line, 'done');
  };
  for (const line of pre.keys()) walk(line, []);

  assert.equal(cycles.length, 0,
    `${cycles.length} prerequisite cycle(s):\n`
    + cycles.map((c) => `  ${c.join(' → ')}`).join('\n'));
});

test('8. every step names a real world', () => {
  const { list, text } = forRules('world');
  assert.equal(list.length, 0,
    `${list.length} step(s) name a world that does not exist.\n`
    + '`_advanceSteps` compares step.world with the world the PLAYER is standing in, so an\n'
    + 'unregistered id is a step that can never fire in any world at all.\n'
    + 'A step MAY name a world other than its quest\'s — that is how a global multi-world quest\n'
    + 'works, and bug #7 (the engagement that resolved to null on reload elsewhere) is fixed —\n'
    + 'but it must name a real one, and its target must be emittable THERE (rule 2).\n'
    + `Registered worlds: ${Object.keys(VOCAB.worlds).join(', ')}\n${text}`);
});

test('10. every quest lives on a board — its own world must permit quests', () => {
  const { list, text } = forRules('quest-world');
  assert.equal(list.length, 0,
    `${list.length} quest(s) are authored into a world that has no quest board.\n`
    + `Worlds with a board: ${VOCAB.questWorlds.join(', ')}\n`
    + `Worlds a STEP may still be scoped to: ${VOCAB.stepWorlds.join(', ')}\n`
    + `Types that keep advancing in a quests:false world: ${UNGATED_STEP_TYPES.join(', ')}\n`
    + `Types that do not: ${GATED_STEP_TYPES.join(', ')}\n${text}`);
});

test('9. every quest pays a reward', () => {
  const { list, text } = forRules('reward');
  assert.equal(list.length, 0, `${list.length} quest(s) reward nothing.\n${text}`);
});

/* ---------------------------------------------------------------------- */
/* The whole picture                                                       */
/* ---------------------------------------------------------------------- */

test('the seeded content is completable end to end', () => {
  const totalSteps = QUESTS.reduce((a, q) => a + (q.steps?.length ?? 0), 0);
  const brokenQuests = new Set(FINDINGS.map((f) => f.quest));
  const brokenSteps = new Set(FINDINGS.filter((f) => f.order != null).map((f) => `${f.quest}:${f.order}`));

  const byRule = new Map();
  for (const f of FINDINGS) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  const byWorld = new Map();
  for (const f of FINDINGS) byWorld.set(f.world, (byWorld.get(f.world) ?? 0) + 1);

  const summary = [
    '',
    `${brokenQuests.size} of ${QUESTS.length} quests and ${brokenSteps.size} of ${totalSteps} steps are unshippable.`,
    '',
    'By reason:',
    ...[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `  ${String(n).padStart(4)}  ${r}`),
    '',
    'By world:',
    ...[...byWorld.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => `  ${String(n).padStart(4)}  ${w}`),
    '',
    report(FINDINGS),
  ].join('\n');

  assert.equal(FINDINGS.length, 0, summary);
});

test('the world vocabulary is exactly the worlds main.js registers', () => {
  /* THE SIGNATURE DEFECT, IN THE RULER ITSELF.
   *
   * `buildWorlds` used to scrape `static id` out of every file in
   * `src/worlds/` and exclude only the id `base`. `PlanetWorld` declares
   * `static id = 'planet'` and is ABSTRACT - `PlanetWorld.of(descriptor)`
   * stamps a subclass per planet and `main.js` registers those, never the base
   * - so `planet` was in the vocabulary as if it were a place. A quest step
   * written `world: 'planet'` validated through `STEP_WORLDS` and was dead
   * forever: content that is BUILT but cannot be REACHED, in the tool that
   * exists to catch content that is built but cannot be reached.
   *
   * And the converse: `cinder`, the one world Phase 1 added that a player can
   * stand in, could not be named by any quest at all, because no file in
   * `src/worlds/` declares `static id = 'cinder'` - the id lives in a
   * descriptor and the class is stamped at runtime.
   *
   * Both directions are asserted, because fixing one and not the other is how
   * this came to be wrong in the first place.
   */
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  const registered = new Set([...src.matchAll(/worldManager\.register\(\s*([A-Za-z_$][\w$]*)\s*\)/g)]
    .map((m) => m[1]));
  assert.ok(registered.size >= 3, `only ${registered.size} register() call sites found in main.js - the scrape is blind`);

  const vocab = Object.keys(VOCAB.worlds).sort();
  assert.ok(!vocab.includes('planet'),
    `VOCAB.worlds carries "planet", which is PlanetWorld's abstract id and is never registered: ${vocab.join(', ')}`);
  assert.ok(vocab.includes('cinder'),
    `VOCAB.worlds does not carry "cinder", the first landable planet, so no quest can name it: ${vocab.join(', ')}`);

  /* Every id in the vocabulary has to be reachable. A world class is reachable
   * when its own name is passed to `register`; a planet is reachable when it is
   * in `src/worlds/planets/index.js`, which `main.js` iterates. */
  const planets = new Set(vocab
    .filter((id) => (VOCAB.worlds[id].files ?? []).some((f) => f.startsWith('src/worlds/planets/'))));
  assert.ok(planets.has('cinder'), 'the cinder entry does not name its own descriptor file');

  /* Every non-planet world in the vocabulary must have a class whose name is
   * registered. Read the class out of the world's own file, which the
   * vocabulary already records. */
  const unreachable = [];
  for (const id of vocab) {
    if (planets.has(id)) continue;
    const file = VOCAB.worlds[id].file;
    const body = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const cls = /export\s+class\s+([A-Za-z_$][\w$]*)\s+extends/.exec(body)?.[1];
    if (!cls || !registered.has(cls)) unreachable.push(`${id} (${file}, class ${cls ?? 'unknown'})`);
  }
  assert.deepEqual(unreachable, [],
    `${unreachable.length} world ids are in the quest vocabulary and are never registered:\n  ${unreachable.join('\n  ')}`);
});
