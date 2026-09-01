import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Onboarding, ONBOARDING_STEPS, ONBOARDING_GRANT } =
  await import('../../src/systems/Onboarding.js');
const { CHARTER_DEEDS } = await import('../../src/systems/Charters.js');
const { EventBus } = await import('../../src/core/EventBus.js');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

/**
 * THE FIRST TWO MINUTES, SIGNED OUT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CONSTRAINT THAT SHAPES ALL OF THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `QuestSystem` cannot accept or complete anything without an account AND a
 * live Postgres (`QuestSystem.js:238`, `:426-442`); offline it degrades in
 * silence to an empty board. The de-facto tutorial in this game was station
 * quests 101-110, which means the de-facto tutorial did not exist for anybody
 * who had not signed in - and a first-run player has not signed in.
 *
 * So the product decision, taken before this file was written, is that
 * ONBOARDING WORKS SIGNED OUT, from bundled local content. Signing in is sold
 * on durability and cross-device, never as a gate on content.
 *
 * The case that enforces that is `nothing here reaches for an account`: this
 * file is scraped for fetch, auth and quest references, because the failure
 * mode is not an error - it is a first-run player being shown a blank panel
 * and never knowing there was supposed to be anything in it.
 *
 * ── The other failure this file exists to catch ────────────────────────────
 *
 * A tutorial step whose event nothing fires. Five quest step verbs were deleted
 * from this codebase after an audit found 0 of 50 seeded quests completable,
 * and every one of them was an authored objective waiting on a channel that did
 * not exist. Every step below names a bus event, and every one of those events
 * is scraped out of `src/`.
 */

/* ====================================================================== */
/* Helpers                                                                */
/* ====================================================================== */

function build(extra = {}) {
  const bus = new EventBus();
  const acquired = [];
  const notes = [];
  bus.on('hud:notify', (p) => notes.push(p));
  const onboarding = new Onboarding({
    bus,
    inventory: { acquire: (id, qty) => acquired.push({ id, qty }) },
    ...extra,
  });
  return { bus, onboarding, acquired, notes };
}

/**
 * Fire whatever satisfies one step, IN THE SHAPE THE GAME FIRES IT.
 *
 * `npc:killed` carries `{ npc, byPlayer, weaponId }` (`Combat.js:460`) and the
 * hostile flag is `npc.type`, not a boolean called `hostile`. A fixture that
 * invented the payload would prove the onboarding works against a game that
 * does not exist - which is this project's signature defect.
 */
const PAYLOAD = {
  'npc:killed': { npc: { type: 'hostile', name: 'Raider' }, byPlayer: true },
};
function satisfy(bus, step) {
  bus.emit(step.event, PAYLOAD[step.event] ?? {});
}

/* ====================================================================== */
/* 1. It is reachable with no account and no network                       */
/* ====================================================================== */

test('nothing in the onboarding reaches for an account', () => {
  const src = readFileSync(join(root, 'src', 'systems', 'Onboarding.js'), 'utf8');
  /* Comments say the words "account", "sign in" and "quest" a great many times
   * on purpose, so the scrape is of CODE: strip block and line comments first. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const forbidden of ['fetch(', 'QuestSystem', 'questSystem', '/api/', 'localStorage']) {
    assert.ok(!code.includes(forbidden),
      `the onboarding reaches for ${forbidden} - a signed-out first-run player would get nothing`);
  }
});

test('every step waits on an event the game actually emits', () => {
  const emitted = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const s = readFileSync(p, 'utf8');
      for (const m of s.matchAll(/emit\??\.?\(\s*'([a-z][\w:-]*)'/g)) emitted.add(m[1]);
    }
  };
  walk(join(root, 'src'));
  assert.ok(emitted.size > 50, 'the emit scrape found almost nothing - it has broken');

  assert.ok(ONBOARDING_STEPS.length >= 7, 'the opening sequence is shorter than the brief asks for');
  for (const step of ONBOARDING_STEPS) {
    assert.ok(emitted.has(step.event),
      `step "${step.id}" waits on "${step.event}", which nothing in src/ emits`);
  }
});

/* ====================================================================== */
/* 1b. THE KEYS IT NAMES ARE KEYS THE GAME ANSWERS                         */
/* ====================================================================== */

/**
 * THE TWO DEAD KEYS, AND WHY NOTHING CAUGHT THEM.
 *
 * ── What shipped ──────────────────────────────────────────────────────────
 *
 *   step 7  "G summons your mount. Get on it."
 *   grant   "Two medkits — yours. Press Tab for your bag."
 *
 * G is `{action:'fittings', code:'KeyG'}` in `Input.BINDABLE`: a HOLD that
 * reinterprets the digit row **while already riding**. Pressed on foot it does
 * precisely nothing. The only player-facing summon is the mount wheel, which is
 * the `map` action, which ships on M. So step 7 of 8 could not be completed by
 * following its own instruction.
 *
 * Tab is worse, because it is not merely the wrong key - it is a key the build
 * is INCAPABLE of answering. It sits in `Input.RESERVED_CODES`, which
 * `setBinding` refuses to write and `_loadBinds` strips out of storage, and
 * nothing anywhere listens for it. The bag is `KeyI` (`main.js`, its own window
 * handler). That sentence is the first reward this game ever hands anybody.
 *
 * ── Why the existing gates could not see either ───────────────────────────
 *
 * The file above asserts that every step names an `event` something emits, and
 * that the `teaches` tags cover the brief's seven verbs. Both are true of a
 * step whose prose tells the player to press a key that does not exist: the
 * event still fires when they eventually stumble on the real control, and the
 * tag is just a word. NOTHING HAD EVER READ THE SENTENCE. That is the gap, and
 * a proofread does not close it - it closes today's instance and leaves the
 * next one to a future reader who has no reason to look.
 *
 * ── What this checks, in both directions ──────────────────────────────────
 *
 *  1. Every key NAME in every player-facing string in `Onboarding.js` resolves
 *     to a code the game actually handles - a `BINDABLE` row, or a literal
 *     `event.code` some file in `src/` tests against. Tab fails here outright,
 *     as would any invented key.
 *  2. The names in a step's prose and its declared `keys` are the SAME SET.
 *     "G summons your mount" beside `keys: ['map']` fails; so does dropping M
 *     from the prose, or adding a key to `keys` and forgetting the sentence.
 *
 * ── What it cannot see, stated rather than implied ────────────────────────
 *
 * `keys` is written by the same hand as the sentence. `keys: ['fittings']`
 * beside "G summons your mount" would pass both directions and still be a lie -
 * the key exists and the two lists agree about it. What the gate removes is the
 * SILENT version: a key can no longer end up in this file's prose without
 * somebody typing its identity down beside it and being wrong on purpose. A
 * static check of English cannot do better than that, and pretending otherwise
 * would be the "gate that measures something the game does not do" this repo
 * has already paid for nine times.
 */

/** Tokens that name a key, and the `event.code` each one means. */
function codesForToken(token) {
  if (/^[A-Z]$/.test(token)) return [`Key${token}`];
  if (/^F(?:[1-9]|1[0-2])$/.test(token)) return [token];
  const named = {
    Space: ['Space'],
    Shift: ['ShiftLeft'],
    Ctrl: ['ControlLeft'],
    Alt: ['AltLeft'],
    Tab: ['Tab'],
    Esc: ['Escape'],
    Escape: ['Escape'],
    Enter: ['Enter'],
  };
  return named[token] ?? null;
}

/**
 * Every key a sentence names, as `event.code`s.
 *
 * Standalone capitals (W, E, R, B, M, G, I), the named keys above, F-keys, and
 * the `1-4` range the weapon-slot line uses. Deliberately greedy about single
 * capitals: a false positive is a test failure somebody has to look at, and a
 * false negative is the defect this file exists to stop.
 */
function keysNamedIn(text) {
  const found = new Set();
  // `1-4` / `1–4`: the digit row, written as a range.
  for (const m of text.matchAll(/\b([1-9])\s*[-–]\s*([1-9])\b/g)) {
    for (let d = Number(m[1]); d <= Number(m[2]); d++) found.add(`Digit${d}`);
  }
  for (const m of text.matchAll(/\b(F(?:[1-9]|1[0-2])|Space|Shift|Ctrl|Alt|Tab|Esc(?:ape)?|Enter|[A-Z])\b/g)) {
    const codes = codesForToken(m[1]);
    if (codes) for (const c of codes) found.add(c);
  }
  return found;
}

/** A `keys` entry - a BINDABLE action or a literal code - as `event.code`s. */
function codeForDeclared(entry, bindable) {
  const row = bindable.find((b) => b.action === entry);
  if (row) return row.code;
  return entry;
}

test('every key the opening sequence names is a key the game answers', async () => {
  const { BINDABLE, RESERVED_CODES } = await import('../../src/core/Input.js');

  /* Every string literal `src/` tests a key code against, comments stripped -
   * this is how `KeyB` (a raw `pressed('KeyB')` poll in `Marketplace`) and
   * `KeyI` (a private window handler in `main.js`) are recognised as real
   * without being `BINDABLE` rows. Same technique `touch-controls.test.mjs`
   * uses to prove no touch button sends a dead key. */
  const handled = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // The onboarding cannot vouch for its own keys.
      if (p.endsWith(join('systems', 'Onboarding.js'))) continue;
      const code = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
      for (const m of code.matchAll(/'((?:Key|Digit|Numpad)[A-Z0-9]|Space|Escape|Tab|Enter|ShiftLeft|ControlLeft|AltLeft|Bracket(?:Left|Right)|F(?:[1-9]|1[0-2]))'/g)) {
        handled.add(m[1]);
      }
    }
  };
  walk(join(root, 'src'));
  assert.ok(handled.has('KeyB') && handled.has('KeyI'),
    'the key-code scrape found neither KeyB nor KeyI - it has broken, and a broken '
    + 'scrape would pass this test for every possible input');

  const bindableCodes = new Set(BINDABLE.map((b) => b.code));
  const reserved = new Set(RESERVED_CODES);

  /* The player-facing strings, taken out of the SOURCE rather than out of
   * `ONBOARDING_STEPS`, because the Tab defect was in the grant's `hud:notify`
   * and not in a step at all. Comments are stripped first: this very file's
   * docblocks say "Tab" and "G" a great many times on purpose. */
  const src = readFileSync(join(root, 'src', 'systems', 'Onboarding.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const strings = [...src.matchAll(/text:\s*(?:'([^']*)'|`([^`]*)`)/g)]
    .map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' '));
  assert.ok(strings.length >= ONBOARDING_STEPS.length + 1,
    `the player-facing string scrape found ${strings.length} - it must reach every step `
    + 'plus the grant notification, or it is measuring nothing');

  for (const text of strings) {
    for (const code of keysNamedIn(text)) {
      assert.ok(!reserved.has(code),
        `"${text}" names ${code}, which is in RESERVED_CODES - it can never be bound `
        + 'and nothing in the game listens for it');
      assert.ok(bindableCodes.has(code) || handled.has(code),
        `"${text}" names ${code}, which is neither a BINDABLE row nor a key any file `
        + 'in src/ handles - a player following that instruction gets nothing');
    }
  }
});

test('a step\'s prose and its declared keys are the same set', async () => {
  const { BINDABLE } = await import('../../src/core/Input.js');

  for (const step of ONBOARDING_STEPS) {
    assert.ok(Array.isArray(step.keys),
      `step "${step.id}" declares no \`keys\` - the prose would be the only record again`);

    const declared = new Set(step.keys.map((k) => codeForDeclared(k, BINDABLE)));
    for (const k of step.keys) {
      const row = BINDABLE.find((b) => b.action === k);
      assert.ok(row || /^(?:Key|Digit|Numpad)/.test(k),
        `step "${step.id}" declares "${k}", which is neither a BINDABLE action nor a key code`);
    }

    const named = keysNamedIn(step.text);
    assert.deepEqual([...named].sort(), [...declared].sort(),
      `step "${step.id}" says "${step.text}" but declares [${[...declared].sort().join(', ')}]. `
      + 'This is the shape of the G-summons-your-mount defect: the sentence and the '
      + 'binding drifted apart and nothing was reading the sentence.');
  }
});

test('the mount step points at the mount wheel, not at the fittings hold', async () => {
  /* The instance, pinned as well as the rule. `fittings` is a HOLD that
   * reinterprets the digit row while already riding; naming it in a step whose
   * event is `mount:mounted` is an instruction a player on foot cannot follow,
   * and it was step 7 of 8. */
  const { BINDABLE } = await import('../../src/core/Input.js');
  const step = ONBOARDING_STEPS.find((s) => s.id === 'mount');
  assert.ok(step, 'the mount step is gone');
  assert.ok(!step.keys.includes('fittings'),
    'the mount step teaches the fittings hold, which does nothing on foot');
  assert.ok(step.keys.includes('map'),
    'the mount step does not teach the mount wheel, which is the only way to summon one');
  const wheel = BINDABLE.find((b) => b.action === 'map');
  assert.ok(step.text.includes(wheel.code.replace('Key', '')),
    `the mount step's text does not name ${wheel.code}, the key the wheel is on`);
});

test('the sequence teaches every verb the brief names', () => {
  /* Movement, interaction, combat, reward, mount, marketplace, and the main
   * objective. Asserted against the `teaches` tag rather than the id, so
   * renaming a step cannot quietly drop one of the seven. */
  const taught = new Set(ONBOARDING_STEPS.map((s) => s.teaches));
  for (const verb of ['movement', 'interaction', 'combat', 'reward', 'mount', 'marketplace', 'objective']) {
    assert.ok(taught.has(verb), `the opening sequence never teaches ${verb}`);
  }
});

/* ====================================================================== */
/* 2. There is always a next action                                        */
/* ====================================================================== */

test('a first-run player is always told exactly one next thing', () => {
  const { bus, onboarding } = build();
  const seen = new Set();
  for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
    const next = onboarding.next();
    assert.ok(next, 'the opening sequence ran out of instructions before it ran out of steps');
    assert.ok(typeof next.text === 'string' && next.text.length > 0,
      `step ${next.id} has no instruction`);
    assert.ok(!seen.has(next.id), 'the same step was offered twice in a row');
    seen.add(next.id);
    satisfy(bus, next);
  }
  assert.equal(onboarding.next(), null, 'the sequence never ends');
  assert.equal(onboarding.complete, true);
});

test('a step credits out of order and the instruction moves on', () => {
  const { bus, onboarding } = build();
  const last = ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
  /* A player who wanders into a marketplace before firing a shot has still
   * learned the marketplace. A tutorial that refused the credit because it was
   * not that player's turn is a tutorial arguing with them. */
  satisfy(bus, last);
  assert.equal(onboarding.done(last.id), true);
  assert.equal(onboarding.next().id, ONBOARDING_STEPS[0].id);
});

test('a kill the player had nothing to do with teaches nothing', () => {
  const { bus, onboarding } = build();
  /* `Combat.js:460` emits `npc:killed` for EVERY death in the world and carries
   * `byPlayer` to say whose it was. Two raiders in a crossfire, a fall, a
   * despawn kill: a tutorial that ticked "put a hostile down" for any of those
   * has taught nothing and taken the instruction off the screen. */
  bus.emit('npc:killed', { npc: { type: 'hostile' }, byPlayer: false });
  assert.equal(onboarding.done('kill'), false, 'somebody else\'s kill counted');

  /* And a civilian is not a hostile, whoever shot them. */
  bus.emit('npc:killed', { npc: { type: 'civilian' }, byPlayer: true });
  assert.equal(onboarding.done('kill'), false, 'a bystander counted as a hostile');

  bus.emit('npc:killed', { npc: { type: 'hostile' }, byPlayer: true });
  assert.equal(onboarding.done('kill'), true);
});

/* ====================================================================== */
/* 3. The early win                                                        */
/* ====================================================================== */

test('a reward lands before the opening loop ends', () => {
  const { bus, onboarding, acquired } = build();
  const grantAt = ONBOARDING_STEPS.findIndex((s) => s.id === ONBOARDING_GRANT.after);
  assert.ok(grantAt >= 0, 'the grant is hung on a step that does not exist');
  /* Before the station-record tail begins, which is the honest version of
   * "inside two minutes": the tail is a trade, a mount and a gateway - three
   * errands across a 744 m dome - and everything before it happens where the
   * player spawns. A reward hung anywhere in the tail is a reward that lands
   * when the opening loop is already over. */
  const tailAt = ONBOARDING_STEPS.length - (CHARTER_DEEDS.station?.length ?? 0);
  assert.ok(grantAt < tailAt,
    'the first reward lands after the opening loop, not before the end of it');

  for (let i = 0; i <= grantAt; i++) satisfy(bus, ONBOARDING_STEPS[i]);
  assert.deepEqual(acquired, [{ id: ONBOARDING_GRANT.item, qty: ONBOARDING_GRANT.qty }]);
});

test('the reward is paid once, however many times the step fires', () => {
  const { bus, onboarding, acquired } = build();
  const step = ONBOARDING_STEPS.find((s) => s.id === ONBOARDING_GRANT.after);
  satisfy(bus, step);
  satisfy(bus, step);
  satisfy(bus, step);
  assert.equal(acquired.length, 1, 'the opening sequence is a medkit press');
  void onboarding;
});

test('the aspirational reward is read from the catalogue, not written here', async () => {
  const { SET_COSMETIC } = await import('../../src/systems/Relics.js');
  const { CHARACTER_SKINS_BY_ID } = await import('../../src/systems/Cosmetics.js');
  const { onboarding } = build();
  const locked = onboarding.lockedReward();
  assert.ok(locked, 'nothing aspirational is on display');
  /* Named from the two catalogues that already own it. A skin id typed into
   * this file would be a fourth copy of a name that exists in three places,
   * and it would be the copy that goes stale. */
  assert.equal(locked.id, SET_COSMETIC);
  assert.equal(locked.name, CHARACTER_SKINS_BY_ID.get(SET_COSMETIC).name);
  assert.ok(locked.locked === true);
});

/* ====================================================================== */
/* 4. It persists by identity, and a load can take it away                 */
/* ====================================================================== */

test('the save carries the steps done, by name', () => {
  const { bus, onboarding } = build();
  satisfy(bus, ONBOARDING_STEPS[0]);
  const snap = onboarding.serialize();
  assert.deepEqual(snap.done, [ONBOARDING_STEPS[0].id]);
  /* One set, and nothing that is a COUNT of it. A stored index would be a
   * second authority, and a build that reordered the sequence would move it
   * onto a different lesson. */
  assert.deepEqual(Object.keys(snap), ['done']);
});

test('a restore replaces rather than merges', () => {
  const { bus, onboarding } = build();
  for (const s of ONBOARDING_STEPS) satisfy(bus, s);
  assert.equal(onboarding.complete, true);

  assert.equal(onboarding.deserialize({ done: [] }), true);
  assert.equal(onboarding.complete, false);
  assert.equal(onboarding.next().id, ONBOARDING_STEPS[0].id);
});

test('an unknown step id in a save is dropped rather than kept', () => {
  const { onboarding } = build();
  /* A save from a build with a step this one does not have. Kept, it would sit
   * in the numerator for ever and the sequence would read "8 of 7". */
  onboarding.deserialize({ done: ['walk_the_dog', ONBOARDING_STEPS[0].id] });
  assert.deepEqual(onboarding.serialize().done, [ONBOARDING_STEPS[0].id]);
});

test('a returning player is never shown the tutorial again', () => {
  const { onboarding } = build();
  onboarding.deserialize({ done: ONBOARDING_STEPS.map((s) => s.id) });
  assert.equal(onboarding.complete, true);
  assert.equal(onboarding.next(), null);
});

test('a restore never pays the grant, and a restored step never re-pays it', () => {
  const { bus, onboarding, acquired } = build();
  onboarding.deserialize({ done: ONBOARDING_STEPS.map((s) => s.id) });
  assert.equal(acquired.length, 0, 'a load granted the opening reward');
  /* The step firing again on a restored save is not a second payout either:
   * the grant hangs on the TRANSITION from outstanding to done, and after a
   * restore there is no transition left to make. */
  satisfy(bus, ONBOARDING_STEPS.find((s) => s.id === ONBOARDING_GRANT.after));
  assert.equal(acquired.length, 0);
});

/* ====================================================================== */
/* 5. It hands off to the objective                                        */
/* ====================================================================== */

test('the opening sequence and the station record ask for the same three things', () => {
  /* The mission design gives the station one job - arrival - and one record:
   * the first trade, the first mount, the first gateway. Those are deeds in
   * `Charters`, and they are the last three steps here. Two lists that mean the
   * same thing and can drift apart is how a player finishes a tutorial and is
   * told they have not started the objective. */
  const deedEvents = new Set((CHARTER_DEEDS.station ?? []).map((d) => d.event));
  const tail = ONBOARDING_STEPS.slice(-deedEvents.size);
  for (const step of tail) {
    assert.ok(deedEvents.has(step.event),
      `the opening sequence ends on "${step.event}", which the station's record does not ask for`);
  }
  assert.equal(tail.length, deedEvents.size);
});
