import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE DEFECTS THE MISSION SURVEY FOUND.
 *
 * Phase 3 was a document-only phase, and writing it meant reading the whole
 * tree. Eight things fell out that had nothing to do with mission design and
 * everything to do with content that does not work. This file pins the ones
 * with a testable shape.
 *
 * Every one of them was silent. Not one produced an error, a warning or a
 * failing test - a missing vendor answered "No vendor nearby", a missing loot
 * table fell back to another world's, a double-counted step just completed
 * sooner than its label promised. That is the class of defect this file exists
 * to make loud.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/* ====================================================================== */
/* 1. Sports had no vendor, and two of its own quest steps needed one      */
/* ====================================================================== */

test('every world whose quests open the marketplace has a vendor in it', () => {
  /* `Marketplace._findVendor` keys on `role`, an explicit `vendor` flag, or
   * trade words in a name or persona. Sports matched none of them, so `B`
   * answered "No vendor nearby" - while sports quest 44 spent two of its four
   * steps telling the player to buy and sell there. Both were uncompletable.
   *
   * Scraped rather than simulated: the failure is a world file and a quest file
   * disagreeing, and only reading both can catch that. */
  const questDir = join(root, 'admin', 'lib', 'quests');
  const worldFile = {
    station: 'StationWorld.js', medieval: 'MedievalWorld.js', sports: 'SportsWorld.js',
    citadel: 'CitadelWorld.js', race: 'RaceWorld.js', dock: 'DockWorld.js',
  };

  const needs = new Set();
  for (const f of readdirSync(questDir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs')) {
    const src = readFileSync(join(questDir, f), 'utf8');
    for (const m of src.matchAll(/\{\s*order:[^}]*?\}/g)) {
      const step = m[0];
      if (!/type:\s*'purchase'/.test(step)) continue;
      const w = step.match(/world:\s*'([a-z]+)'/);
      if (w) needs.add(w[1]);
    }
  }
  assert.ok(needs.size > 0, 'no purchase steps found - the scrape has broken');

  /* A world may author its trader inline (`role: 'vendor'`) or generate one in
   * its own subdirectory - medieval's come out of `medieval/Population.js` with
   * a `vendorTitle` and categories attached. Both count; what does not count is
   * neither, which is what sports had. */
  const hasVendor = (world, file) => {
    const files = [read('src', 'worlds', file)];
    try {
      for (const n of readdirSync(join(root, 'src', 'worlds', world))) {
        if (n.endsWith('.js')) files.push(read('src', 'worlds', world, n));
      }
    } catch { /* no subdirectory, which is normal */ }
    return files.some((s) => /role:\s*'vendor'|vendorTitle\s*[:=]/.test(s));
  };

  for (const world of needs) {
    const file = worldFile[world];
    if (!file) continue;                       // a world with no hand-authored file
    assert.ok(hasVendor(world, file),
      `${world} has quest steps that open the marketplace, but nothing in it spawns a vendor. `
      + 'Pressing B there answers "No vendor nearby" and those steps cannot be completed.');
  }
});

test('the sports trader satisfies the real vendor matcher, not just a grep', async () => {
  /* The previous assertion only proved the string `role: 'vendor'` appears in
   * the file. What decides whether `B` opens a shop is `Marketplace._isVendor`,
   * so this runs the ACTUAL matcher over the ACTUAL authored spawn specs.
   *
   * `_isVendor` reads no `this`, so it can be called off the prototype without
   * standing up a Marketplace, a player or an NPC manager. */
  const { Marketplace } = await import('../../src/systems/Marketplace.js');
  const isVendor = (npc) => Marketplace.prototype._isVendor.call(null, npc);

  const src = read('src', 'worlds', 'SportsWorld.js');
  const block = src.slice(src.indexOf('this.npcSpawns = ['), src.indexOf('hostilePosts'));

  const specs = [];
  for (const m of block.matchAll(/name:\s*'((?:[^'\\]|\\.)*)',\s*\n\s*persona:\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)) {
    const seg = block.slice(Math.max(0, m.index - 400), m.index + 400);
    specs.push({
      name: m[1].replace(/\\'/g, "'"),
      persona: m[2].replace(/\\'/g, "'"),
      role: /role:\s*'vendor'/.test(seg) ? 'vendor' : undefined,
      type: 'friendly',
    });
  }
  assert.ok(specs.length >= 6, `expected the sports cast, parsed ${specs.length}`);

  const traders = specs.filter(isVendor);
  assert.ok(traders.length >= 1,
    'no sports NPC satisfies Marketplace._isVendor, so B answers "No vendor nearby". '
    + `Parsed cast: ${specs.map((s) => s.name).join(', ')}`);
});

/* ====================================================================== */
/* 2. Vellum Ridge paid out another world's loot                           */
/* ====================================================================== */

test('every world that allows caches has its own cache table', () => {
  /* `_roll` falls back to `CACHE_TABLES.station`, and did it silently, so the
   * racing world's caches dropped station bullets and station alloy for its
   * entire life. Nothing errored; the loot was simply from somewhere else. */
  const caches = read('src', 'systems', 'Caches.js');
  const block = caches.slice(caches.indexOf('const CACHE_TABLES'), caches.indexOf('\n};', caches.indexOf('const CACHE_TABLES')));
  const declared = new Set([...block.matchAll(/^\s{2}([a-z]+):\s*\[/gm)].map((m) => m[1]));

  /* The worlds that keep caches on. Maze, space and the planets turn them off
   * in their own rules, which is why they are absent here rather than missing. */
  for (const world of ['station', 'medieval', 'sports', 'citadel', 'dock', 'race']) {
    assert.ok(declared.has(world),
      `CACHE_TABLES has no "${world}" row, so its caches silently pay out the station table.`);
  }
});

test('a missing cache table is reported rather than swallowed', () => {
  const caches = read('src', 'systems', 'Caches.js');
  const roll = caches.slice(caches.indexOf('_roll(rnd'), caches.indexOf('_roll(rnd') + 900);
  assert.match(roll, /console\.warn/,
    'the fallback must say something - a silent one is how the race row stayed missing');
});

/* ====================================================================== */
/* 3. `defend` counted a killing blow twice                                */
/* ====================================================================== */

test('a killing blow advances defend once, not twice', () => {
  /* Every authored defend step means "land N hits" and says so in its own
   * label - "every hit counts, she does not have to fall". A killing blow
   * emits `npc:damaged` then `npc:killed`; advancing on both made the last hit
   * count twice, so "land 6 hits" fell to three kills. */
  const src = read('src', 'systems', 'QuestSystem.js');
  /* Anchored on the METHOD, not the name. The bus wiring near the top of the
   * file contains `this._onKill(e)` and `this._onNpcDamaged(e)` on adjacent
   * lines, so a bare indexOf sliced two lines of constructor and asserted
   * happily about nothing. */
  const killAt = src.search(/\n\s{2}_onKill\s*\(e\)\s*\{/);
  const dmgAt = src.search(/\n\s{2}_onNpcDamaged\s*\(/);
  assert.ok(killAt > 0 && dmgAt > killAt, 'the kill/damage handlers have moved or been renamed');
  const onKill = src.slice(killAt, dmgAt);

  assert.match(onKill, /_advanceSteps\('kill'/, '_onKill must still advance kill steps');
  assert.ok(!/_advanceSteps\('defend'/.test(onKill),
    '_onKill must NOT advance defend - `npc:damaged` already fires for the killing blow, '
    + 'so counting it here makes the final hit count twice');

  const onDamaged = src.slice(dmgAt, dmgAt + 400);
  assert.match(onDamaged, /_advanceSteps\('defend'/,
    'damage is the single path for defend now, so it has to be there');
});

test('every authored defend step is worded as hits, not kills', () => {
  /* The fix above is only right while that is what defend means. If a step ever
   * asks for kills, this fails and the counting has to be reconsidered. */
  const questDir = join(root, 'admin', 'lib', 'quests');
  let seen = 0;
  for (const f of readdirSync(questDir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs')) {
    const src = readFileSync(join(questDir, f), 'utf8');
    for (const m of src.matchAll(/\{\s*order:[^}]*?\}/g)) {
      if (!/type:\s*'defend'/.test(m[0])) continue;
      seen++;
      assert.match(m[0], /[Ll]and \d+ hits/,
        `a defend step in ${f} is not worded as landing hits: ${m[0].slice(0, 120)}`);
    }
  }
  assert.ok(seen >= 6, `expected the six authored defend steps, saw ${seen}`);
});

/* ====================================================================== */
/* 4. The manual-completion method that nothing called                     */
/* ====================================================================== */

test('there is no unvalidated manual step-completion path', () => {
  /* `markStepDone` set `done = true` for ANY step type and then posted the
   * completion the server pays on. It had zero callers, and `window.GAME`
   * exposes `questSystem` under `?dev=1`, which main.js says plainly is not a
   * security boundary. */
  const src = read('src', 'systems', 'QuestSystem.js');
  assert.ok(!/^\s*async markStepDone\s*\(/m.test(src),
    'markStepDone is back. If a board needs manual completion it must validate the '
    + 'step type, not mark any of the eleven done on request.');
});

/* ====================================================================== */
/* 5. Untargeted steps match everything — an authoring hazard              */
/* ====================================================================== */

test('every authored quest step carries a target', () => {
  /* `_matchesStepTarget` returns true for a step with no target, so
   * `{type:'kill', count:5}` would complete on any five hostiles anywhere -
   * farmable, and immune to the herbivore guard's intent.
   *
   * Not one of the 398 authored steps is untargeted today, so this is a fence
   * rather than a fix: the danger is writing one, and this is where writing one
   * becomes a build failure. */
  const questDir = join(root, 'admin', 'lib', 'quests');
  const offenders = [];
  let total = 0;
  for (const f of readdirSync(questDir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs')) {
    const src = readFileSync(join(questDir, f), 'utf8');
    for (const m of src.matchAll(/\{\s*order:\s*\d+,[^}]*?\}/g)) {
      const step = m[0];
      if (!/type:\s*'/.test(step)) continue;
      total++;
      if (!/target:\s*'/.test(step)) offenders.push(`${f}: ${step.slice(0, 120)}`);
    }
  }
  assert.ok(total > 300, `expected ~398 steps, parsed ${total} - the scrape has broken`);
  assert.deepEqual(offenders, [],
    'a step with no target matches every event of its type:\n' + offenders.join('\n'));
});

/* ====================================================================== */
/* 6. The gateway signed a world that does not exist                       */
/* ====================================================================== */

test('gateway 01 signs the world it actually leads to', () => {
  /* The sign atlas said "ASHFALL REACH" twice and the portal label said
   * "Ashfall Reach", while the world is Aldermoor Vale - which is what the HUD
   * toast, the lore, the quest manager's sign and the market label all say. A
   * player read one name on the arch and heard another on arrival. "Ashfall" is
   * a Citadel region AND a Cinder landing pad, so it was not even unused. */
  const station = read('src', 'worlds', 'StationWorld.js');
  const medieval = read('src', 'worlds', 'MedievalWorld.js');

  const name = medieval.match(/static\s+displayName\s*=\s*'([^']+)'/)?.[1];
  assert.equal(name, 'Aldermoor Vale', 'MedievalWorld.displayName has moved');

  const spec = station.match(/\{\s*target:\s*'medieval',\s*label:\s*'([^']+)'/)?.[1];
  assert.equal(spec, name, 'the gateway spec must sign the world it targets');
  assert.ok(!/ASHFALL REACH/.test(station),
    'the sign atlas still reads ASHFALL REACH somewhere');
});
