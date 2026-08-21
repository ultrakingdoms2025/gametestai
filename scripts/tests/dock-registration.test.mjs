import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { VOCAB } from '../quest-vocab.mjs';

/**
 * LODESTAR YARD IS REGISTERED, AND NOT QUIETLY THE STATION.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE IS WORTH MORE THAN THE OTHER FIVE COMBINED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Adding a world to this engine means adding a row to about twenty tables, and
 * FOURTEEN of those rows fail SILENTLY. A world that misses them boots, looks
 * right, walks right, and is quietly the space station:
 *
 *   THEME_BY_WORLD        the whole cast wears Aether Nexus deck uniforms.
 *                         This is not hypothetical - twenty-five citadel crowd
 *                         slots stood in a desert souk dressed as station
 *                         dockhands for an entire release.
 *   FALLBACK_NAMES        NOT silent: `names[nameIndex++ % names.length]` has
 *                         no `??`, so a theme named in THEME_BY_WORLD without
 *                         a row here is a TypeError on the first unnamed
 *                         friendly. Asserted anyway, because the loud failure
 *                         only happens once the crowd filler reaches it.
 *   CROWD_NAMES/PERSONAS  `?? .station`. Yard hands with concourse small talk.
 *   WEAPON_TABLES         `?? .station`. A desert garrison dropped 6 mm
 *                         caseless for a release for the equivalent reason.
 *   ROLE_CAST             `?? .station`. Quartermaster Bex, in a shipyard.
 *   Humanoid's four       `?? 'station'`. citadel and maze are STILL falling
 *                         back through these; the yard must not be a seventh.
 *   MERCHANT_SIGN_WORLD   every stall sign in the yard reads "DOCK".
 *   DROP_TABLES           the fallback made two shipped citadel quest steps
 *                         ask for ammunition the world does not manufacture,
 *                         and they PASSED validation because of it.
 *   CACHE_TABLES          same shape, same silence.
 *   SUPPLY_WANTS          the shipyard that makes hull plate asks you to fetch
 *                         it nexus shards.
 *   WORLD_MARKETS         `activeMarket = null` and flat pricing, silently.
 *   GRADE_PRESETS         no colour grade at all. citadel, race, maze and the
 *                         old survey site still have none.
 *   SCORES                TOTAL SILENCE. `setWorld` sets `score = null`.
 *   DEFAULT_LORE          the keeper recites the Chronicle at you.
 *   buildLorePersona      WORSE than silent: the canonical-facts sentence is
 *                         hardcoded, and left alone the Yard Warden tells the
 *                         player the yard does not exist.
 *
 * None of that is visible in a playtest for about a week. All of it is one
 * assertion each here.
 *
 * ── Why so much of this is scraped rather than imported ───────────────────
 * `CACHE_TABLES`, `SUPPLY_WANTS`, `MERCHANT_SIGN_WORLD`, `GRADE_PRESETS`,
 * `SCORES`, `PALETTES` and `CLOTH_KIND` are all module-private consts, and
 * three of the modules holding them cannot be imported under Node at all
 * (`Caches` paints canvases in its constructor, `PostFX` needs a renderer,
 * `Music` needs an AudioContext). Exporting them purely to be tested would
 * widen seven module surfaces to check a table row. So those are read out of
 * the source text, and every regex below is anchored on the const name so a
 * scrape that stops working fails LOUD - see the "the scrape still works"
 * test, which is the guard on the rest of the file.
 *
 * The model for the whole file is `quest-content.test.mjs:554-587`, which pins
 * `DROP_TABLES.citadel` with the message "the station fallback is back".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/** The world id and the character theme it maps to. */
const WORLD = 'dock';
const THEME = 'dock';

/* ------------------------------------------------------------------ */
/* Scrapers                                                            */
/* ------------------------------------------------------------------ */

/**
 * The body of a top-level object literal, by const name, brace-matched.
 *
 * A regex cannot balance braces and these tables are full of nested objects,
 * so this walks the text. It returns the SOURCE of the object, which is all
 * the assertions below need: they ask whether a key is present and, where a
 * number matters, pull that number out of the key's own row.
 */
function objectBody(src, constName) {
  /* The lazy `(?::[^=]*?)?` swallows a TypeScript type annotation — `const X:
   * Record<W, { ammoBuy: number; ... }> = {` in the site catalogue — which
   * spans lines and contains both braces and semicolons, so nothing narrower
   * than "anything without an `=` in it" will do. It is anchored on the const
   * name at one end and on `= {` at the other, and there is no `=` between
   * them in any declaration this file reads. */
  const m = new RegExp(`(?:const|let|export const)\\s+${constName}\\s*(?::[^=]*?)?=\\s*(?:Object\\.freeze\\()?\\{`).exec(src);
  assert.ok(m, `${constName} is gone or has been renamed - this scrape is dead`);
  /* The opening brace of the VALUE, which is the last character the match
   * consumed - NOT the first `{` after the const name. Those differ whenever
   * the declaration carries a type annotation with an object in it, and taking
   * the first one hands back the TYPE and every key lookup then quietly
   * misses. */
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`${constName} is not brace-balanced`);
  return '';
}

/** The source of one top-level key inside an object body, brace-matched. */
function keyBody(body, key) {
  const at = body.search(new RegExp(`(^|[\\s,{])${key}\\s*:\\s*[[{]`, 'm'));
  if (at === -1) return null;
  const openAt = body.slice(at).search(/[[{]/) + at;
  const open = body[openAt];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = openAt; i < body.length; i++) {
    const c = body[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return body.slice(openAt, i + 1);
    }
  }
  return null;
}

/** Does a top-level object literal carry this key, whatever its value shape? */
function hasKey(src, constName, key) {
  const body = objectBody(src, constName);
  if (keyBody(body, key) !== null) return true;
  return new RegExp(`(^|[\\s,{])${key}\\s*:`, 'm').test(body);
}

/** The first `key: <number>` inside a fragment of source. */
function num(fragment, key) {
  const m = new RegExp(`${key}\\s*:\\s*(-?[\\d.]+)`).exec(fragment);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ */
/* Imported halves                                                     */
/* ------------------------------------------------------------------ */

const { DROP_TABLES } = await import('../../src/systems/Loot.js');
const { ITEMS, WORLD_MARKETS } = await import('../../src/systems/ItemDefs.js');
const {
  THEME_BY_WORLD, FALLBACK_NAMES, CROWD_NAMES, CROWD_PERSONAS,
} = await import('../../src/npc/NPCManager.js');
const { WEAPON_TABLES } = await import('../../src/npc/NPCWeapons.js');
const { ROLE_CAST, ROLE } = await import('../../src/npc/NPCRoles.js');
const { THEME_VARIANTS, THEME_RIM } = await import('../../src/npc/Humanoid.js');
const { DEFAULT_LORE, LORE_ORDER, buildLorePersona, loreEntryForScope } =
  await import('../../src/content/Lore.js');
const PLAN = await import('../../src/worlds/dock/YardPlan.js');

const SRC = {
  caches: read('src/systems/Caches.js'),
  contracts: read('src/systems/Contracts.js'),
  npcManager: read('src/npc/NPCManager.js'),
  humanoid: read('src/npc/Humanoid.js'),
  postfx: read('src/gfx/PostFX.js'),
  music: read('src/audio/Music.js'),
  marketplace: read('src/systems/Marketplace.js'),
  catalogue: read('site/lib/marketplaceCatalog.ts'),
  main: read('src/main.js'),
  dock: read('src/worlds/DockWorld.js'),
  space: read('src/worlds/SpaceWorld.js'),
  adminDb: read('admin/lib/db.ts'),
  adminLorePage: read('admin/app/dashboard/lore/page.tsx'),
  harness: read('src/dev/Harness.js'),
  station: read('src/worlds/StationWorld.js'),
};

/* ====================================================================== */
/* 0. The guard on everything else                                        */
/* ====================================================================== */

test('the scrapes still work - a dead scrape must not read as a pass', () => {
  /* Every scraped assertion below is of the form "this table has a dock row".
   * A scrape that silently stopped finding the table would report an empty
   * body and the row would be missing, which fails loudly - but a scrape that
   * silently found the WRONG thing could pass. So each scraped table is first
   * checked against a row that has existed for releases: if `station` is not
   * in it, the scrape is not looking at the table it thinks it is. */
  assert.ok(hasKey(SRC.caches, 'CACHE_TABLES', 'station'), 'CACHE_TABLES scrape lost the station row');
  assert.ok(hasKey(SRC.contracts, 'SUPPLY_WANTS', 'station'), 'SUPPLY_WANTS scrape lost the station row');
  assert.ok(hasKey(SRC.npcManager, 'MERCHANT_SIGN_WORLD', 'station'), 'MERCHANT_SIGN_WORLD scrape lost the station row');
  assert.ok(hasKey(SRC.postfx, 'GRADE_PRESETS', 'station'), 'GRADE_PRESETS scrape lost the station row');
  assert.ok(hasKey(SRC.music, 'SCORES', 'station'), 'SCORES scrape lost the station row');
  assert.ok(hasKey(SRC.humanoid, 'PALETTES', 'station'), 'PALETTES scrape lost the station row');
  assert.ok(/CLOTH_KIND\s*=\s*\{[^}]*station:/.test(SRC.humanoid), 'CLOTH_KIND scrape lost the station row');
});

/* ====================================================================== */
/* 1. The world is registered at all                                      */
/* ====================================================================== */

test('the yard and the space beyond it are registered, and the survey site is gone', () => {
  assert.match(SRC.main, /import \{ DockWorld \} from '\.\/worlds\/DockWorld\.js'/);
  assert.match(SRC.main, /worldManager\.register\(DockWorld\)/);
  assert.match(SRC.main, /worldManager\.register\(SpaceWorld\)/);
  assert.doesNotMatch(SRC.main, /SurveyWorld/, 'SurveyWorld is still registered');
  assert.match(SRC.dock, /static id = 'dock'/);
  assert.match(SRC.dock, /static displayName = 'Lodestar Yard'/);
  assert.match(SRC.space, /static id = 'space'/);
  /* `WorldManager.build` disposes and regenerates a volatile world on every
   * request. The yard has a state - a countdown board, cradles a ship stage
   * hangs hulls on, placed caches and relics - so it must not be one. */
  assert.doesNotMatch(SRC.dock, /^\s*static volatile/m, 'the yard must not be volatile');
});

test('the station ring routes gateway six at the yard, and still has six gateways', () => {
  assert.match(SRC.station, /\{ target: 'dock', label: 'Lodestar Yard'/,
    'the gateway table row still points at the survey site');
  assert.doesNotMatch(SRC.station, /target: 'survey'/);
  /* The row is EDITED, never removed: `GATEWAY_BEARINGS_DEG` is six long and
   * the builder throws if the two disagree, so deleting the row would build
   * five gateways and leave a bearing empty. */
  const table = /const table = \[([\s\S]*?)\n    \];/.exec(SRC.station);
  assert.ok(table, 'the gateway table moved');
  const rows = [...table[1].matchAll(/\{ target: '([a-z]+)'/g)].map((m) => m[1]);
  assert.equal(rows.length, 6, `the ring builds ${rows.length} gateways, not 6`);
  assert.ok(rows.includes('dock'), 'gateway six does not lead to the yard');
});

test('the sign atlas keeps all 44 reserved roles and gateway six has four of them', () => {
  /* `RESERVED_ROLES = 44` in station-floor-numbers.test.mjs, and `SIGN_ROLE`
   * indexes `SIGNS` POSITIONALLY - so retiring the survey site by deleting its
   * four rows would re-letter nothing (they are last) but would shorten the
   * sheet's last row to zero cells, and `paintSignAtlas` destructures every
   * cell in the sheet unconditionally. The rows are replaced in place. */
  const roles = objectBody(SRC.station, 'SIGN_ROLE');
  for (const gone of ['gatewaySurvey', 'approachSurvey', 'surveyWarning', 'surveyEnquiries']) {
    assert.doesNotMatch(roles, new RegExp(`\\b${gone}\\b`), `${gone} survived the retirement`);
  }
  assert.match(roles, /gatewayDock:\s*40/);
  assert.match(roles, /approachDock:\s*41/);
  assert.match(roles, /dockTraffic:\s*42/);
  assert.match(roles, /dockEnquiries:\s*43/);
  /* 33 NAMED roles reserving 44 CELLS: `shopFirst` is a base index covering
   * the commercial strip's twelve shopfronts, and the other 32 are one cell
   * each. `station-floor-numbers.test.mjs` pins the 44, so what matters here
   * is that retiring the survey site did not renumber anything or leave a
   * hole - the roles are positional indices into `SIGNS`, and a hole is a sign
   * painted from a cell nothing reserves. */
  const claimed = [...roles.matchAll(/([a-zA-Z]+)\s*:\s*(\d+)/g)].map((m) => Number(m[2]));
  assert.equal(claimed.length, 33, `SIGN_ROLE names ${claimed.length} roles, not 33`);
  assert.equal(Math.max(...claimed), 43, 'the last reserved cell is not 43 - the sheet has been resized');
  const single = claimed.filter((n) => n >= 12).sort((a, b) => a - b);
  assert.deepEqual(single, Array.from({ length: 32 }, (_, i) => i + 12),
    'cells 12-43 are not each claimed exactly once - a sign is painted from a cell nothing reserves');
  assert.equal(12 + single.length, 44, 'twelve shopfronts plus the reserved roles is not 44 cells');
});

/* ====================================================================== */
/* 2. THE FOURTEEN SILENT ROWS                                            */
/* ====================================================================== */

test('SILENT: the cast is dressed as a yard, not as the station', () => {
  assert.equal(THEME_BY_WORLD[WORLD], THEME,
    'no THEME_BY_WORLD row - every character in the yard wears an Aether Nexus deck uniform');
});

test('LOUD BUT LATE: FALLBACK_NAMES has a row for the theme', () => {
  /* `spawnForWorld` reads `FALLBACK_NAMES[this.theme]` with NO `??` and then
   * indexes it, so this is a TypeError rather than a fallback - but only once
   * an unnamed friendly actually spawns, which is deep into a playtest. */
  const names = FALLBACK_NAMES[THEME];
  assert.ok(Array.isArray(names) && names.length >= 4,
    `FALLBACK_NAMES.${THEME} is missing - the first unnamed friendly is a TypeError`);
  for (const n of names) assert.ok(typeof n === 'string' && n.length > 3);
  assert.match(SRC.npcManager, /const names = FALLBACK_NAMES\[this\.theme\];/,
    'the unguarded read this test exists for has changed shape');
});

test('SILENT: the crowd has its own names and its own small talk', () => {
  assert.ok(CROWD_NAMES[THEME]?.length >= 8,
    'no CROWD_NAMES row - the yard fills up with Deck Tech Ruiz and Hauler Kito');
  assert.ok(CROWD_PERSONAS[THEME]?.length >= 3,
    'no CROWD_PERSONAS row - yard hands talking about recycled concourse coffee');
  // ...and they are not the station's, copied.
  assert.notDeepEqual(CROWD_NAMES[THEME], CROWD_NAMES.station);
  assert.notDeepEqual(CROWD_PERSONAS[THEME], CROWD_PERSONAS.station);
});

test('SILENT: the stationary roles have a yard cast', () => {
  const cast = ROLE_CAST[THEME];
  assert.ok(cast, 'no ROLE_CAST row - Quartermaster Bex is standing in a shipyard');
  for (const role of [ROLE.VENDOR, ROLE.GUARD, ROLE.SPECTATOR, ROLE.LOITERER]) {
    assert.ok(Array.isArray(cast[role]) && cast[role].length >= 1,
      `ROLE_CAST.${THEME} has no ${role}`);
    for (const c of cast[role]) {
      assert.ok(c.name && c.persona?.length > 40, `${role} entry is a stub`);
      assert.ok(!ROLE_CAST.station[role]?.some((s) => s.name === c.name),
        `${c.name} is a station character wearing a yard label`);
    }
  }
});

test('SILENT: hostiles here would draw from a yard table, not the armoury', () => {
  /* The rule is off today and the row exists anyway, for the reason the row in
   * `DROP_TABLES` exists: the rule can flip and the fallback is silent. */
  const table = WEAPON_TABLES[THEME];
  assert.ok(Array.isArray(table) && table.length >= 3, 'no WEAPON_TABLES row for the yard');
  const byId = Object.fromEntries(table);
  assert.ok((byId.baton ?? 0) > (byId.rifle ?? 0),
    'a civilian worksite whose security carries more rifles than spanners is the station table');
});

test('SILENT: the merchant signs say where they are', () => {
  const body = objectBody(SRC.npcManager, 'MERCHANT_SIGN_WORLD');
  assert.match(body, /dock:\s*'LODESTAR YARD'/,
    'no MERCHANT_SIGN_WORLD row - every stall in the yard is signed "DOCK"');
});

test('SILENT: the yard has a costume set in ALL FOUR Humanoid tables', () => {
  /* Four tables, and three of them fall back to `station` without a word. The
   * fourth (`THEME_VARIANTS`) is the one that decides whether the other three
   * are consulted at all: `create` does `THEME_VARIANTS[params.theme] ? theme
   * : 'station'`, so a palette without a variants row is dead code.
   *
   * The GARMENT BUILDERS are shared with the station on purpose - `runOutfit`
   * falls through to `buildStationOutfit` for anything not medieval or sports,
   * so `eva`/`rig`/`jumpsuit` are three builders that exist, and they are the
   * three a shipyard wears. What must NOT be shared is the palette, the cloth
   * and the rim, which is where a costume set actually lives. */
  assert.ok(Array.isArray(THEME_VARIANTS[THEME]) && THEME_VARIANTS[THEME].length >= 3,
    'no THEME_VARIANTS row - every other table in Humanoid.js is unreachable for this theme');
  for (const v of THEME_VARIANTS[THEME]) {
    assert.ok(THEME_VARIANTS.station.includes(v) || new RegExp(`variant === '${v}'`).test(SRC.humanoid),
      `variant "${v}" has no builder anywhere - it resolves to the default garment and the table lies`);
  }

  const palettes = objectBody(SRC.humanoid, 'PALETTES');
  const dockPal = keyBody(palettes, THEME);
  assert.ok(dockPal, 'no PALETTES row - the yard wears station colours');
  const entries = [...dockPal.matchAll(/\{ primary: (0x[0-9a-f]{6}), secondary: (0x[0-9a-f]{6})/g)];
  assert.ok(entries.length >= 6, `PALETTES.${THEME} has only ${entries.length} outfits`);
  const stationPal = keyBody(palettes, 'station');
  assert.notEqual(dockPal.replace(/\s/g, ''), stationPal.replace(/\s/g, ''),
    'the yard palette is the station palette copied - that is a seventh broken theme with extra steps');

  /* The value contract, asserted rather than trusted: no character albedo
   * under ~0.045 linear (a figure that crushes to a silhouette) and a
   * secondary that is genuinely the high-value anchor. sRGB -> linear on the
   * max channel is close enough to judge a costume by. */
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const maxLin = (hex) => Math.max(lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255));
  /* The floor is DERIVED from the station's own set rather than picked. The
   * rule in `Humanoid.js`'s header - "no character albedo below ~0.045 linear"
   * - is about the figure as a whole, and the station's warm-neutral primaries
   * run down to 0.028 because they are the DARK 60% that the secondary reads
   * against. So the honest statement is that the yard is no darker than the
   * world whose costume contract it borrowed, and that its secondary is
   * genuinely the high-value anchor. */
  const stationEntries = [...stationPal.matchAll(/\{ primary: (0x[0-9a-f]{6}), secondary: (0x[0-9a-f]{6})/g)];
  const floor = Math.min(...stationEntries.map((e) => maxLin(Number(e[1]))));
  assert.ok(floor > 0.02 && floor < 0.05, `the derived floor is ${floor} - the station palette scrape broke`);
  for (const [, primary, secondary] of entries) {
    const p = maxLin(Number(primary));
    const sv = maxLin(Number(secondary));
    assert.ok(p >= floor,
      `primary ${primary} is ${p.toFixed(3)} linear, under the station set's own floor of ${floor.toFixed(3)} - it will crush to a silhouette`);
    assert.ok(sv > p * 2.5,
      `secondary ${secondary} (${sv.toFixed(3)}) is not the high-value anchor over primary ${primary} (${p.toFixed(3)})`);
    assert.ok(sv >= 0.45 && sv <= 0.72,
      `secondary ${secondary} is ${sv.toFixed(3)} linear; the contract is 0.45-0.60 with a little slack`);
  }

  assert.match(SRC.humanoid, new RegExp(`CLOTH_KIND\\s*=\\s*\\{[^}]*\\b${THEME}:`),
    'no CLOTH_KIND row - the yard gets whatever `kind` undefined selects');
  assert.ok(THEME_RIM[THEME], 'no THEME_RIM row - the yard borrows the station rim');
  assert.notDeepEqual(THEME_RIM[THEME], THEME_RIM.station);
  assert.ok(THEME_RIM[THEME].strength > 0.2 && THEME_RIM[THEME].strength < 0.9);
});

test('SILENT: the yard has its own drop table and it makes what the yard makes', () => {
  const t = DROP_TABLES[WORLD];
  assert.ok(Array.isArray(t) && t.length >= 4, 'DROP_TABLES.dock went away - the station fallback is back');
  const ids = t.map((e) => e.id);
  for (const want of ['laser_cell', 'hull_plate', 'alloy_scrap']) {
    assert.ok(ids.includes(want), `the yard drops no ${want}`);
  }
  /* The refusals matter more than the inclusions, and they are the same shape
   * of refusal `DROP_TABLES.citadel` exists for: a station item the fallback
   * would have made "technically obtainable" in a world that produces none. */
  for (const gone of ['bullet', 'arrow', 'fireball_charge', 'relic_coin']) {
    assert.ok(!ids.includes(gone), `a shipyard does not manufacture ${gone}`);
  }
  for (const e of t) assert.ok(ITEMS[e.id], `DROP_TABLES.dock names "${e.id}", which is not in ITEMS`);
});

test('SILENT: the caches pay in the yard s own goods', () => {
  const body = keyBody(objectBody(SRC.caches, 'CACHE_TABLES'), WORLD);
  assert.ok(body, 'CACHE_TABLES.dock is missing - the caches pay out the station table');
  for (const want of ['alloy_scrap', 'hull_plate', 'laser_cell']) {
    assert.match(body, new RegExp(`id: '${want}'`), `the yard's caches hold no ${want}`);
  }
  assert.doesNotMatch(body, /id: 'bullet'/, 'a shipyard cache full of rifle rounds is the station table');
});

test('SILENT: the yard asks for what a yard wants', () => {
  const body = keyBody(objectBody(SRC.contracts, 'SUPPLY_WANTS'), WORLD);
  assert.ok(body, 'SUPPLY_WANTS.dock is missing - the yard asks you to fetch it nexus shards');
  for (const want of ['hull_plate', 'thruster_coil', 'alloy_scrap']) {
    assert.match(body, new RegExp(`id: '${want}'`), `the yard does not ask for ${want}`);
  }
  assert.doesNotMatch(body, /nexus_shard/, 'the station row is showing through');
});

test('SILENT: regional pricing, and the SECOND copy of it agrees', () => {
  const m = WORLD_MARKETS[WORLD];
  assert.ok(m, 'WORLD_MARKETS.dock is missing - the yard trades at flat prices, silently');
  assert.ok(m.buy && m.sell && m.itemBuy, 'the dock market row is a stub');
  /* The yard is the inverse of the citadel and the assertions say so in both
   * directions, so a later edit that flattens one of them shows up. */
  assert.ok(m.itemBuy.alloy_scrap < WORLD_MARKETS.medieval.itemBuy.alloy_scrap,
    'a yard that pays more for scrap than a village with no foundry is not a yard');
  assert.ok(m.itemBuy.relic_coin > WORLD_MARKETS.citadel.itemBuy.relic_coin,
    'a yard with no relic culture should pay MORE for a crown coin than the citadel does');
  assert.ok(m.itemBuy.hull_plate < 1 && m.itemBuy.thruster_coil < 1,
    'the yard makes plate and coil; it must not pay over the odds for them');

  /* THE UNENFORCED CORRESPONDENCE. `WORLD_PRICE_MULTIPLIERS` in the site
   * catalogue is a second, independent statement of these four numbers, and
   * NOTHING anywhere compares them - the game would price a medkit at 1.1 and
   * the storefront at 1.0 with no error on either side. */
  const mult = keyBody(objectBody(SRC.catalogue, 'WORLD_PRICE_MULTIPLIERS'), WORLD);
  assert.ok(mult, "site/lib/marketplaceCatalog.ts has no dock row - `Record<MarketplaceWorld, ...>` should not even compile");
  assert.equal(num(mult, 'ammoBuy'), m.buy.ammo, 'ammoBuy disagrees with WORLD_MARKETS.dock.buy.ammo');
  assert.equal(num(mult, 'ammoSell'), m.sell.ammo, 'ammoSell disagrees with WORLD_MARKETS.dock.sell.ammo');
  assert.equal(num(mult, 'consumableBuy'), m.buy.consumable, 'consumableBuy disagrees with WORLD_MARKETS.dock.buy.consumable');
  assert.equal(num(mult, 'consumableSell'), m.sell.consumable, 'consumableSell disagrees with WORLD_MARKETS.dock.sell.consumable');
});

test('SILENT: the yard has a colour grade of its own', () => {
  /* Auto-selected by world id, so the row IS the wiring. citadel, race and
   * maze still have none, which is why every one of them renders through the
   * neutral look with no argument recorded anywhere. */
  const body = keyBody(objectBody(SRC.postfx, 'GRADE_PRESETS'), WORLD);
  assert.ok(body, 'GRADE_PRESETS.dock is missing - the yard renders through the neutral look');
  assert.match(body, /bloom:\s*\{[^}]*threshold:\s*([\d.]+)/);
  const th = num(body, 'threshold');
  const stationTh = num(keyBody(objectBody(SRC.postfx, 'GRADE_PRESETS'), 'station'), 'threshold');
  assert.ok(th < stationTh,
    `the yard blooms at ${th} against the station's ${stationTh} - its practicals are an order of magnitude dimmer, so a threshold at or above the station's means nothing in the world blooms at all`);
  assert.ok(keyBody(objectBody(SRC.postfx, 'GRADE_PRESETS'), 'space'), 'GRADE_PRESETS.space is missing');
});

test('SILENT: no registered world boots into silence', () => {
  /* `Music.setWorld` does `SCORES[worldId] ?? null` and a null score is TOTAL
   * SILENCE - which reads as the audio having broken rather than as a design.
   *
   * It was asserted for two named worlds and it should have been asserted for
   * all of them: `SCORES` carried eight of the nine, and the one it missed was
   * `cinder` - the volcanic surface, the destination the whole Phase 1 loop
   * exists to reach. Landing on it faded the space score out and started
   * nothing, so the payoff of the loop was silent, and silent immediately
   * after a track that had been playing the entire way there.
   *
   * So the list comes from the quest vocabulary, which is derived from what
   * `main.js` actually registers, rather than from two hand-typed ids. A world
   * added without a score is now red on the day it is added.
   */
  const scores = objectBody(SRC.music, 'SCORES');
  const ids = Object.keys(VOCAB.worlds).sort();
  assert.ok(ids.length >= 8, `only ${ids.length} worlds in the vocabulary - the scrape is blind`);
  const silent = ids.filter((id) => !keyBody(scores, id));
  assert.deepEqual(silent, [],
    `${silent.length} registered worlds have no row in Music.SCORES and boot into TOTAL SILENCE: ${silent.join(', ')}`);
  // A score is not a score without a tempo and a progression to hang on it.
  for (const id of ids) {
    const body = keyBody(scores, id);
    assert.match(body, /bpm:\s*\d+/, `SCORES.${id} has no bpm`);
    assert.match(body, /progression:\s*\[/, `SCORES.${id} has no progression`);
  }
});

test('SILENT: the lore exists, is ordered, and the keeper knows the yard is there', () => {
  assert.ok(DEFAULT_LORE.dock, 'no DEFAULT_LORE.dock - the Yard Warden recites the Chronicle');
  assert.ok(DEFAULT_LORE.space, 'no DEFAULT_LORE.space - one of the yard\'s two keepers recites the Chronicle');
  assert.ok(LORE_ORDER.includes('dock') && LORE_ORDER.includes('space'));
  assert.ok(!LORE_ORDER.includes('survey'), 'LORE_ORDER still carries the retired survey scope');
  assert.equal(DEFAULT_LORE.dock.sign_label, 'Yard Warden');
  assert.ok(DEFAULT_LORE.dock.body.length > 200, 'the yard lore is a stub');
  assert.equal(loreEntryForScope('dock').scope, 'dock');
  assert.equal(loreEntryForScope('space').scope, 'space');

  /* THE WORST ROW IN THE CHECKLIST. `buildLorePersona`'s canonical-facts
   * sentence is hardcoded prose, derived from nothing and checked by nothing,
   * and it is the lorekeeper's ONLY map of the Nexus. It read "six worlds ...
   * five outbound portals" while the station had six gateways, so a keeper
   * standing in the world behind gateway six would tell the player that world
   * did not exist. */
  const persona = buildLorePersona('dock');
  /* Matched inside the PARENTHESISED WORLD LIST, not anywhere in the sentence.
   * A mutation that dropped the yard from the list still left the words
   * "Lodestar Yard" in the clause after it, and a bare /Lodestar Yard/ passed
   * — which is the difference between the keeper knowing the yard is one of
   * the worlds and the keeper merely having heard of it. */
  const list = /the Nexus has [a-z]+ worlds[^(]*\(([^)]*)\)/.exec(persona);
  assert.ok(list, 'the canonical-facts sentence no longer lists the worlds at all');
  assert.match(list[1], /Lodestar Yard/,
    "the yard is not in the lorekeeper's list of worlds — the Yard Warden denies the yard exists");
  assert.match(list[1], /Aether Station/, 'the world-list scrape has stopped working');
  assert.match(persona, /six outbound portals/,
    'the canonical-facts sentence still says the hub has five outbound portals');
  assert.doesNotMatch(persona, /the Nexus has six worlds/,
    'the world count in the canonical-facts sentence is stale again');
  // ...and the persona actually carries the yard's own body text.
  assert.ok(persona.includes(DEFAULT_LORE.dock.body.slice(0, 60)));
});

test('SILENT: the admin surfaces can edit the new scopes', () => {
  const rows = SRC.adminDb;
  assert.match(rows, /scope: 'dock'/, 'DEFAULT_LORE_ROWS cannot seed the yard');
  assert.match(rows, /scope: 'space'/, 'DEFAULT_LORE_ROWS cannot seed open space');
  const page = SRC.adminLorePage;
  for (const scope of ['maze', 'dock', 'space']) {
    assert.match(page, new RegExp(`'${scope}'`), `the admin lore page cannot edit "${scope}"`);
  }
});

/* ====================================================================== */
/* 3. The marketplace, both halves                                        */
/* ====================================================================== */

test("'ships' is a category in BOTH copies, or the counter becomes a general trader", () => {
  /* Half-done is the dangerous half. `normalizeCategory` throws on an unknown
   * category, which is loud; `Marketplace._readVendorCategories` silently
   * DROPS one, so a counter authored `vendorCategories: ['ships']` with the
   * game-side list unchanged opens the whole catalogue instead of none of it. */
  const game = /const ALL_CATEGORIES = \[([^\]]*)\]/.exec(SRC.marketplace);
  assert.ok(game, 'ALL_CATEGORIES moved');
  const site = /export const MARKETPLACE_CATEGORIES = \[([^\]]*)\]/.exec(SRC.catalogue);
  assert.ok(site, 'MARKETPLACE_CATEGORIES moved');
  const gameCats = [...game[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const siteCats = [...site[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(gameCats.includes('ships'), "src/systems/Marketplace.js ALL_CATEGORIES has no 'ships'");
  assert.ok(siteCats.includes('ships'), "site MARKETPLACE_CATEGORIES has no 'ships'");
  assert.deepEqual(gameCats, siteCats, 'the two category lists have drifted apart');
});

test('the yard is a marketplace world, and its counters stock the whole catalogue', () => {
  const worlds = /export const MARKETPLACE_WORLDS = \[([^\]]*)\]/.exec(SRC.catalogue);
  assert.ok(worlds, 'MARKETPLACE_WORLDS moved');
  const ids = [...worlds[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(ids.includes('dock'),
    "'dock' is not a MARKETPLACE_WORLD - `normalizeWorld` THROWS on it, which takes the whole listing down");

  /* The other half of the exemption in citadel-cast.test.mjs: that file lets
   * the citadel not stock `ships`, and this one insists SOMEBODY does. Between
   * them the statement "every category is buyable somewhere" survives. */
  const cats = [...SRC.dock.matchAll(/vendorCategories:\s*\[([^\]]*)\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]));
  assert.ok(cats.length, 'the yard authors no vendorCategories - every counter is a general trader');
  const game = /const ALL_CATEGORIES = \[([^\]]*)\]/.exec(SRC.marketplace);
  for (const c of [...game[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])) {
    assert.ok(cats.includes(c), `nothing in Lodestar Yard sells "${c}"`);
  }
  assert.ok(cats.includes('ships'), 'the world that HAS the ships does not sell them');
  // Three counters, and none of them is a general trader.
  const counters = [...SRC.dock.matchAll(/vendorCategories:\s*\[([^\]]*)\]/g)];
  assert.equal(counters.length, 3, `the yard authors ${counters.length} counters, not 3`);
});

test('every new item is real, priced, and reachable by some means', () => {
  for (const id of ['laser_cell', 'hull_plate', 'thruster_coil']) {
    const def = ITEMS[id];
    assert.ok(def, `${id} is not in ITEMS - inventory refuses it and Marketplace.sell returns unavailable`);
    assert.ok(def.value > 0 && def.stack > 0);
    assert.ok(['ammo', 'consumable', 'trinket', 'currency', 'skin'].includes(def.kind),
      `${id} has kind "${def.kind}", which is not one the inventory understands`);
    assert.ok(def.desc.length > 40, `${id} has no real description`);
  }
  /* `laser_cell`'s stack is sized like ammunition on purpose - it becomes
   * ammunition in the flight drop - and 240 is four racks of sixty, matching
   * `bullet`'s one-stack-one-slot rule. */
  assert.equal(ITEMS.laser_cell.stack % ITEMS.bullet.stack, 0,
    'a laser cell rack should be a whole number of bullet stacks, or the slot maths stops reading');
});

/* ====================================================================== */
/* 4. Optional-but-do-it rows                                             */
/* ====================================================================== */

test('the dev harness can frame every world in the loop', () => {
  const views = objectBody(SRC.harness, 'VIEWS');
  const dock = keyBody(views, 'dock');
  assert.ok(dock, 'VIEWS.dock is missing - the yard cannot be reviewed');
  const names = [...dock.matchAll(/name: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `only ${names.length} dock framings`);
  /* The first frame of the world has to be one of them: it is taken from the
   * exact point `arrivalFor` puts a player, and if that framing is not legible
   * nothing else in the yard gets looked at. */
  assert.ok(names.includes('apron-arrival'), 'no framing from the arrival point');
  /* `blast-door` was on this list and the blast door has been deleted - the
   * mouth is open now. The three rows that replaced it are what a review of
   * this world is actually for, and `harness-framings.test.mjs` proves each of
   * them looks at something. */
  for (const want of ['trench', 'crane-cab', 'mouth-inside', 'office-inside']) {
    assert.ok(names.includes(want), `no dock framing called "${want}"`);
  }
  assert.ok(!names.includes('blast-door'), 'VIEWS.dock still frames the deleted blast door');
  assert.ok(keyBody(views, 'space'), 'VIEWS.space is missing');
  /* And the planet. It had NO entry at all: the first landable world in the
   * game could not be reviewed through the tool reviews are taken with. */
  assert.ok(keyBody(views, 'cinder'), 'VIEWS.cinder is missing - the volcanic surface cannot be reviewed');
});

test('the quest arc is wired into the seed and takes the next free number block', async () => {
  const { ALL_QUESTS, DOCK_QUESTS } = await import('../../admin/lib/quests/index.mjs');
  assert.equal(DOCK_QUESTS.length, 10, `the yard authors ${DOCK_QUESTS.length} quests, not 10`);
  const ns = DOCK_QUESTS.map((q) => q.n).sort((a, b) => a - b);
  assert.deepEqual(ns, [51, 52, 53, 54, 55, 56, 57, 58, 59, 60], 'the yard is not on numbers 51-60');
  for (const q of DOCK_QUESTS) {
    assert.equal(q.world, 'dock');
    assert.ok(ALL_QUESTS.includes(q), `Q${q.n} is not exported through admin/lib/quests/index.mjs`);
  }
  // Numbers are unique across every world, because `quest_number` is the DB key.
  const all = ALL_QUESTS.map((q) => q.n);
  assert.equal(new Set(all).size, all.length, 'two quests share a quest_number');
  /* The final step of the final quest is the hook the flight drop lands on,
   * and it is completable TODAY: walking the blast-door portal emits
   * `quest:activity {type:'interact', target:'dock->space'}`. */
  const last = DOCK_QUESTS.find((q) => q.n === 60);
  assert.ok(last.steps.some((s) => s.type === 'interact' && s.target === 'dock->space'),
    'quest 60 does not end at the launch portal');
});

/* ====================================================================== */
/* 5. Things the world itself must publish                                */
/* ====================================================================== */

test('the plan is a single source of truth and the world reads it', () => {
  /* Every number the yard is dimensioned off lives in one three-free module,
   * so a test can read the plan without building the world and a builder
   * cannot quietly disagree with it. */
  assert.equal(PLAN.DECK_Y, 0);
  assert.equal(PLAN.GANTRY_Y, 8.0);
  assert.equal(PLAN.ROOF_Y, 26.0);
  assert.ok(PLAN.TRENCH_Y < 0 && PLAN.TRENCH_Y > -7.5,
    'the trench must be a drop with no fall damage: fall damage starts at 7.5 m');
  assert.equal(PLAN.BERTHS.length, 4, 'the yard has four berths');
  assert.equal(new Set(PLAN.BERTHS.map((b) => b.id)).size, 4, 'two berths share an id');
  assert.equal(PLAN.COUNTERS.length, 3);
  assert.equal(PLAN.STAIRS.length, 2, 'the gantry is reached by two flights, at either end');

  /* The stair pitch, checked rather than remembered: the treads are drawn over
   * a ramp proxy so the riser is cosmetic, but a flight steeper than the
   * gantry's is a thing this world should have to argue for. */
  const pitch = (Math.atan2(PLAN.GANTRY_Y, PLAN.STAIR_RUN) * 180) / Math.PI;
  assert.ok(pitch > 30 && pitch < 40, `the gantry flights are ${pitch.toFixed(1)} degrees`);
  assert.ok(PLAN.STAIR_RISE < 0.45, `a ${PLAN.STAIR_RISE} m riser is over stepHeight`);

  /* The launch portal is on BERTH ZERO'S DOCKING CRADLE. Not in a cockpit,
   * and no longer on the deck in front of a blast door, because there is no
   * blast door: the north end is an open mouth with five piers running out of
   * it and the one empty pier is where a ship leaves from and comes back to.
   *
   * Checked against the pier rather than against a hard-coded z, so the portal
   * and the pad it stands on cannot drift apart. */
  const zero = PLAN.PIERS.find((p) => p.dock);
  assert.ok(zero, 'no pier is marked as the docking berth');
  const zeroPad = PLAN.pierPad(zero);
  assert.ok(PLAN.PORTAL_SPACE_Z < zeroPad.z0 && PLAN.PORTAL_SPACE_Z > zeroPad.z1,
    `the launch portal at z ${PLAN.PORTAL_SPACE_Z} is not on Berth Zero's pad `
    + `(${zeroPad.z1}..${zeroPad.z0})`);
  assert.equal(zero.x, 0, 'Berth Zero is not on the keel line the whole world points down');
  assert.ok(PLAN.PORTAL_STATION_Z < PLAN.YARD_Z1 && PLAN.PORTAL_STATION_Z > PLAN.YARD_Z1 - 12);

  // The trench never runs through the datum island.
  for (const [z0, z1] of PLAN.TRENCH_RUNS) {
    assert.ok(z1 <= -PLAN.DATUM_ISLAND_HZ || z0 >= PLAN.DATUM_ISLAND_HZ,
      'a trench run crosses the datum island - the benchmark is bolted to virgin slab');
  }
  // Every bay lies inside a run, and every bay is a ramp with two ends.
  for (const b of PLAN.TRENCH_BAYS) {
    const inRun = PLAN.TRENCH_RUNS.some(([z0, z1]) => b.z0 >= z0 && b.z1 <= z1);
    assert.ok(inRun, `trench bay ${b.id} is not inside a trench run`);
    assert.ok(Math.abs(b.up) === 1, `trench bay ${b.id} has no ramp direction`);
  }
  // No crossing column stands in the keel corridor.
  for (const x of PLAN.CROSSING_COLUMN_X) {
    assert.ok(Math.abs(x) > PLAN.KEEL_HW + 8,
      `a crossing column at x ${x} stands in the keel corridor`);
  }
});
