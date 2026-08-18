import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import {
  NPCManager, THEME_BY_WORLD, FALLBACK_NAMES, CROWD_NAMES, CROWD_PERSONAS,
} from '../../src/npc/NPCManager.js';
import { ROLE, ROLE_CAST, castFor } from '../../src/npc/NPCRoles.js';
import { Marketplace } from '../../src/systems/Marketplace.js';
import { CitadelWorld } from '../../src/worlds/CitadelWorld.js';
import { Physics } from '../../src/physics/Physics.js';
import { EventBus } from '../../src/core/EventBus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/**
 * WHO IS STANDING IN THE CITADEL.
 *
 * Two defects, one file, because they are the same defect seen from two ends.
 *
 *  1. `THEME_BY_WORLD` had no `citadel` entry, so `spawnForWorld` set
 *     `theme = 'station'` and every table keyed on theme handed the mesa the
 *     station's: Deck Tech Ruiz and Quartermaster Bex, twenty-five of them,
 *     talking about hull maintenance backlogs and recycled coffee in a desert
 *     fortress. It is silent because every lookup has a `?? station` on it.
 *
 *  2. The four hand-written citadel characters carried a name and a persona and
 *     nothing else - no `role`, so `Marketplace._isVendor` could only reach
 *     them through the `VENDOR_WORDS` regex, which matches one of the four by
 *     accident and misses the other two shops entirely; no `vendorCategories`,
 *     so `WORLD_MARKETS.citadel`'s price table had no counter to be quoted
 *     across; no `signLines`, so no stall in the world is lettered; and no
 *     `isQuestManager`.
 *
 * Plus the recorded trap, re-pinned here rather than trusted: `spawnOne` - the
 * streaming path - once silently dropped `signLines`, `vendorCategories`,
 * `vendorTitle` and `isQuestManager`. It carries them today. This file asserts
 * that both paths produce the SAME character from the SAME spec, which is the
 * only form of the assertion that cannot rot the way the original did.
 */

/* ---------------------------------------------------------------------- */
/* Headless scaffolding                                                    */
/* ---------------------------------------------------------------------- */

/**
 * `NPC._attachSign` paints its placard on a 2D canvas, which is the one DOM
 * call on the whole spawn path. Stubbed rather than skipped, because the point
 * of these tests is that the sign is REQUESTED - a stub that swallowed
 * `setSignLines` would pass whether or not the world authored one.
 */
function withDocument(fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const prev = globalThis.document;
  const ctx2d = new Proxy({}, {
    get: (_t, k) => (k === 'canvas' ? null : () => {}),
    set: () => true,
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }),
  };
  try {
    return fn();
  } finally {
    if (had) globalThis.document = prev;
    else delete globalThis.document;
  }
}

/** The citadel mesa, flat, big enough for every authored spawn. */
function citadelPhysics() {
  const physics = new Physics(null);
  physics.addBox(0, 7, 0, 400, 14, 400);
  return physics;
}

function manager(physics) {
  return new NPCManager({
    scene: { add() {}, remove() {} },
    engine: null,
    physics,
    bus: new EventBus(),
    materials: null,
    player: null,
  });
}

/** The citadel's own spawn list, built by the world rather than transcribed. */
function citadelSpawns() {
  const w = new CitadelWorld({ physics: citadelPhysics() });
  w._fillSpawns();
  return w.npcSpawns;
}

const namedSpawns = () => citadelSpawns().filter((s) => s.type !== 'hostile');
const byName = (n) => namedSpawns().find((s) => s.name === n);

/** Every name any station-themed table can produce. */
function stationNamePool() {
  const out = new Set([...CROWD_NAMES.station, ...FALLBACK_NAMES.station]);
  for (const list of Object.values(ROLE_CAST.station)) for (const c of list) out.add(c.name);
  return out;
}

/* ---------------------------------------------------------------------- */
/* 1. The theme                                                            */
/* ---------------------------------------------------------------------- */

test('the citadel has a theme of its own', () => {
  assert.ok(THEME_BY_WORLD.citadel,
    'THEME_BY_WORLD has no citadel entry, so spawnForWorld falls back to the station theme');
  assert.notEqual(THEME_BY_WORLD.citadel, 'station',
    'mapping the citadel to the station theme is the defect, spelled out');
});

test('every theme a world can be given has a complete set of tables behind it', () => {
  /* `spawnForWorld` reads `FALLBACK_NAMES[this.theme]` with NO `??` fallback
   * (unlike CROWD_NAMES and CROWD_PERSONAS, which have one). Naming a theme in
   * THEME_BY_WORLD without adding its row is therefore not a cosmetic omission,
   * it is a TypeError the first time that world spawns a friendly with no
   * authored name - which is every lorekeeper-free world with a short cast. */
  assert.match(read('src/npc/NPCManager.js'), /const names = FALLBACK_NAMES\[this\.theme\];/,
    'FALLBACK_NAMES is no longer read unguarded - re-check whether this test still bites');
  for (const [world, theme] of Object.entries(THEME_BY_WORLD)) {
    for (const [label, table] of [
      ['FALLBACK_NAMES', FALLBACK_NAMES], ['CROWD_NAMES', CROWD_NAMES],
      ['CROWD_PERSONAS', CROWD_PERSONAS], ['ROLE_CAST', ROLE_CAST],
    ]) {
      const row = table[theme];
      assert.ok(row, `${world} uses theme "${theme}" and ${label} has no such row`);
      assert.ok(Object.keys(row).length > 0, `${label}.${theme} is empty`);
    }
  }
});

test('the citadel crowd shares no name with the station crowd', () => {
  const station = stationNamePool();
  const theme = THEME_BY_WORLD.citadel;
  const citadel = [...(CROWD_NAMES[theme] ?? []), ...(FALLBACK_NAMES[theme] ?? [])];
  for (const list of Object.values(ROLE_CAST[theme] ?? {})) for (const c of list) citadel.push(c.name);
  assert.ok(citadel.length >= 12, `only ${citadel.length} citadel names - the crowd will repeat itself`);
  for (const n of citadel) {
    assert.equal(station.has(n), false, `"${n}" is a station name being used in the citadel`);
  }
});

test('the citadel cast fills every role the crowd filler hands out', () => {
  /* `_populateHubs` walks ROLE_ROTATION and calls `castFor(theme, role, i)`.
   * A role with no citadel entry silently falls through to a generic crowd
   * name, which is fine for the tail of a long rotation and not fine for the
   * VENDOR at slot 0 - the Marketplace opens next to whoever that is. */
  const theme = THEME_BY_WORLD.citadel;
  const station = stationNamePool();
  for (const role of [ROLE.VENDOR, ROLE.GUARD, ROLE.SPECTATOR, ROLE.LOITERER]) {
    const cast = castFor(theme, role, 0);
    assert.ok(cast, `castFor('${theme}', '${role}', 0) is null - the crowd's first ${role} is unnamed`);
    /* `castFor` answers `ROLE_CAST[theme] ?? ROLE_CAST.station`, so it is never
     * null and asserting only that it answered proves nothing. What it must not
     * answer is a station character. */
    assert.equal(station.has(cast.name), false,
      `the citadel's first ${role} is "${cast.name}", who works on the station`);
    assert.ok(cast.persona && cast.persona.length > 40,
      `the citadel ${role} has no persona worth handing a chat model`);
  }
});

/* ---------------------------------------------------------------------- */
/* 2. The four named characters                                            */
/* ---------------------------------------------------------------------- */

test('the four named citadel characters are still the four named citadel characters', () => {
  const named = namedSpawns();
  assert.deepEqual(named.map((s) => s.name),
    ['Rafiq the Keeper', 'Hafsa the Dyer', 'Bashir the Ostler', 'Yusra the Falconer'],
    'the citadel cast changed - every expectation below is written against these four');
});

test('every named citadel character declares a role', () => {
  for (const s of namedSpawns()) {
    assert.ok(typeof s.role === 'string' && s.role.length,
      `${s.name} has no role, so nothing downstream can key on what they are`);
    assert.ok(Object.values(ROLE).includes(s.role), `${s.name} has role "${s.role}", which is not a ROLE`);
  }
});

test('the citadel shops are reachable by role, not by the accident of a word match', () => {
  /* `Marketplace._isVendor` tries `isVendor`/`role` first and falls back to
   * matching VENDOR_WORDS against name and persona. Before the roles were
   * authored, that regex was the ONLY route into a citadel shop: it matches
   * Hafsa's "cloth stall" and misses Rafiq's archive and Bashir's stable
   * entirely, so two of the three counters in the world could not be opened. */
  const isVendor = (spec) => Marketplace.prototype._isVendor.call(null, spec);
  const vendors = namedSpawns().filter(isVendor);
  assert.ok(vendors.length >= 3,
    `only ${vendors.length} of the four named citadel characters read as a trader `
    + `(${vendors.map((v) => v.name).join(', ') || 'none'})`);

  // ...and by role rather than by prose: strip the words and they still trade.
  for (const v of vendors) {
    assert.equal(isVendor({ role: v.role, name: 'X', persona: 'Y' }), true,
      `${v.name} only reads as a trader because of the words in their persona`);
  }
});

test('a citadel vendor stocks part of the catalogue, and between them they stock all of it', () => {
  /* `WORLD_MARKETS.citadel` prices six kinds of goods and the mesa has exactly
   * one portal off it, so a category no counter stocks is a category the player
   * cannot buy in this world at all. `Marketplace.ALL_CATEGORIES` is the list;
   * scraped rather than exported because it is one line and this is the only
   * caller outside that module. */
  const all = /const ALL_CATEGORIES = \[([^\]]*)\]/.exec(read('src/systems/Marketplace.js'));
  assert.ok(all, 'ALL_CATEGORIES moved');
  const categories = [...all[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  const stocked = new Set();
  let counters = 0;
  for (const s of namedSpawns()) {
    if (s.role !== ROLE.VENDOR) continue;
    counters++;
    assert.ok(Array.isArray(s.vendorCategories) && s.vendorCategories.length,
      `${s.name} is a vendor with no vendorCategories, so their stall opens the whole catalogue`);
    assert.ok(s.vendorCategories.length < categories.length,
      `${s.name} stocks everything, which is the same as authoring nothing`);
    for (const c of s.vendorCategories) {
      assert.ok(categories.includes(c), `${s.name} stocks "${c}", which is not a marketplace category`);
      stocked.add(c);
    }
    assert.ok(typeof s.vendorTitle === 'string' && s.vendorTitle.length,
      `${s.name}'s stall has no vendorTitle`);
  }
  assert.ok(counters >= 3, `the citadel authors only ${counters} counters`);
  for (const c of categories) {
    assert.ok(stocked.has(c), `nothing in the citadel sells "${c}" - and there is one portal off the mesa`);
  }
});

test('every citadel stall and desk is lettered', () => {
  for (const s of namedSpawns()) {
    if (s.role !== ROLE.VENDOR && s.isQuestManager !== true) continue;
    assert.ok(Array.isArray(s.signLines) && s.signLines.length === 2,
      `${s.name} has no two-line sign; NPC._attachSign draws at most two`);
    for (const line of s.signLines) {
      assert.equal(line, String(line).toUpperCase(), `${s.name}'s sign line "${line}" is not upper case`);
    }
    assert.equal(s.signLines[1], 'SUNSPIRE CITADEL',
      `${s.name}'s sign does not say where it is - the second line is the wayfinding half`);
  }
});

test('giving the cast posts does not cost the citadel its wanderer or its talk targets', () => {
  /* The two ways authoring roles goes wrong, both found by running
   * `quest-content.test.mjs` against a first draft of this work rather than by
   * reasoning about it:
   *
   *  - all four characters were previously WANDERERs, because `spawnForWorld`
   *    defaults `role` to `ROLE.WANDERER`. Give all four a post and the role
   *    disappears from the world, and Q31 step 2 - `talk:"wanderer"` - can
   *    never advance again.
   *  - Yusra is a `talk` target in Q33, Q36 and Q40. `HUD.js` emits `interact`
   *    rather than `talk` for anyone flagged `isQuestManager`, so promoting
   *    her to a second quest desk silently breaks all three. The world already
   *    has a desk: `_spawnQuestManagers` plants Aldric Storne beside Rafiq.
   */
  const named = namedSpawns();
  const wanderers = named.filter((s) => s.role === ROLE.WANDERER);
  assert.equal(wanderers.length, 1,
    `${wanderers.length} citadel wanderers - the role must exist here exactly once, `
    + 'or a shipped quest step loses its only target');
  assert.equal(wanderers[0].name, 'Yusra the Falconer');

  const desks = named.filter((s) => s.isQuestManager === true);
  assert.deepEqual(desks.map((s) => s.name), [],
    'a named citadel character was flagged as a quest desk; the three quests that talk to '
    + 'Yusra would start emitting interact instead');
  // The planted desk is still the world's desk, and still nowhere near Yusra.
  const aldric = new THREE.Vector3(8, 14.3, 88);
  assert.ok(wanderers[0].position.distanceTo(aldric) > 30,
    'Yusra has drifted next to the planted quest desk');
});

/* ---------------------------------------------------------------------- */
/* 3. Driven through the real manager                                      */
/* ---------------------------------------------------------------------- */

test('spawnForWorld dresses the citadel from citadel tables and nothing else', () => withDocument(() => {
  const physics = citadelPhysics();
  const mgr = manager(physics);
  const world = new CitadelWorld({ physics });
  world._fillSpawns();
  mgr.spawnForWorld(world);

  assert.equal(mgr.theme, THEME_BY_WORLD.citadel, 'the manager did not take the citadel theme');
  assert.ok(mgr._friendlies.length >= 20, `only ${mgr._friendlies.length} friendlies in the citadel`);

  const station = stationNamePool();
  for (const npc of mgr._friendlies) {
    assert.equal(station.has(npc.name), false,
      `"${npc.name}" is a station-themed name standing in the citadel`);
  }
}));

test('the authored citadel dressing survives the trip through spawnForWorld', () => withDocument(() => {
  const physics = citadelPhysics();
  const mgr = manager(physics);
  const world = new CitadelWorld({ physics });
  world._fillSpawns();
  mgr.spawnForWorld(world);

  const find = (n) => mgr._friendlies.find((x) => x.name === n);
  for (const spec of namedSpawns()) {
    const npc = find(spec.name);
    assert.ok(npc, `${spec.name} was not spawned at all`);
    if (spec.role === ROLE.VENDOR) {
      assert.equal(npc.isVendor, true, `${spec.name} is not a vendor on the spawned character`);
      assert.deepEqual(npc.vendorCategories, spec.vendorCategories, `${spec.name} lost their stock list`);
      assert.equal(npc.vendorTitle, spec.vendorTitle, `${spec.name} lost their stall title`);
      assert.ok(mgr._vendors.includes(npc), `${spec.name} is not in the manager's vendor list`);
    }
    if (spec.signLines) {
      assert.deepEqual(npc.signLines, spec.signLines, `${spec.name}'s sign was not the authored one`);
    }
    assert.equal(npc.isQuestManager, spec.isQuestManager === true, `${spec.name}'s quest desk flag is wrong`);
  }
}));

test('spawnOne produces the same character from the same spec as spawnForWorld', () => withDocument(() => {
  /* The recorded trap. `spawnOne` is the streaming path, and it once dropped
   * signLines / vendorCategories / vendorTitle / isQuestManager on the floor -
   * a shop that arrived by streaming opened the whole catalogue, unlettered.
   * Asserting the two paths AGREE is what keeps this honest: a future edit that
   * adds a fifth piece of dressing to `spawnForWorld` and forgets `spawnOne`
   * fails here without anyone having to remember to extend the list. */
  const DRESSING = ['role', 'isVendor', 'vendorCategories', 'vendorTitle', 'signLines', 'isQuestManager'];
  const snapshot = (npc) => Object.fromEntries(DRESSING.map((k) => [k, npc[k] ?? null]));

  for (const spec of namedSpawns()) {
    const viaWorld = manager(citadelPhysics());
    viaWorld.worldId = 'citadel';
    viaWorld.theme = THEME_BY_WORLD.citadel ?? 'station';
    const world = { id: 'citadel', npcSpawns: [spec], portalSpecs: [], rules: { crowd: false, hostiles: false } };
    viaWorld.spawnForWorld(world);
    // `_spawnQuestManagers` plants Aldric Storne alongside, whatever the cast.
    const authored = viaWorld._friendlies.find((x) => x.name === spec.name);
    assert.ok(authored, `${spec.name} did not spawn through spawnForWorld`);

    const viaStream = manager(citadelPhysics());
    viaStream.worldId = 'citadel';
    viaStream.theme = THEME_BY_WORLD.citadel ?? 'station';
    const streamed = viaStream.spawnOne(spec);
    assert.ok(streamed, `${spec.name} did not spawn through spawnOne`);

    assert.deepEqual(snapshot(streamed), snapshot(authored),
      `${spec.name} is a different character depending on which path spawned them`);
  }
}));

test('a streamed citadel merchant carries a stock list, a title and a lettered sign', () => withDocument(() => {
  /* The same trap stated positively, so the test above cannot pass by both
   * paths being equally broken. */
  const mgr = manager(citadelPhysics());
  mgr.worldId = 'citadel';
  mgr.theme = THEME_BY_WORLD.citadel ?? 'station';
  const spec = namedSpawns().find((s) => s.role === ROLE.VENDOR);
  assert.ok(spec, 'the citadel authors no vendor at all');

  const npc = mgr.spawnOne(spec);
  assert.equal(npc.isVendor, true);
  assert.deepEqual(npc.vendorCategories, spec.vendorCategories);
  assert.equal(npc.vendorTitle, spec.vendorTitle);
  assert.deepEqual(npc.signLines, spec.signLines);
  assert.notDeepEqual(npc.signLines, ['MERCHANT', 'SUNSPIRE CITADEL'],
    'the authored sign was dropped and _createNPC substituted the generic merchant placard');

  /* The citadel authors no desk of its own (see the wanderer test above), so
   * the quest-manager half of the dressing is exercised on a synthetic spec -
   * it is the field the original defect lost most expensively and it must not
   * go untested just because this world happens not to use it. */
  const desk = mgr.spawnOne({
    ...spec, name: 'Desk Under Test', role: 'quest_manager', isQuestManager: true,
    vendorCategories: undefined, vendorTitle: undefined,
  });
  assert.equal(desk.isQuestManager, true, 'a streamed quest desk arrived without its board');
  assert.equal(mgr.spawnOne({ ...spec, name: 'Not A Desk' }).isQuestManager, false,
    'isQuestManager is being set for a spec that did not ask for it');
}));
