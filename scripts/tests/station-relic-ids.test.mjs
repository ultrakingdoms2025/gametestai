import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildStation, THREE } from './world-kit.mjs';
import { Relics, MATCH_R } from '../../src/systems/Relics.js';

/**
 * THE STATION'S RELIC IDENTITIES, PINNED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GUARDS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 7 of the station placement re-plan re-authors placement DISTRICT BY
 * DISTRICT, and its per-release gate reads "relic id set stable or reconciled".
 * Nothing in the tree enumerated that set, so the gate had nothing to read and
 * a release could only satisfy it by assertion. This file is the enumeration.
 *
 * A relic id is minted by `idOf(pos)` (`src/systems/Relics.js:335`) as
 * `${x}:${z}`, both coordinates quantised to half a metre. Those ids are the
 * SAVE FORMAT: `Relics.serialize` writes `foundIds[worldId]`, and `_applyIds`
 * restores a player's ledger by claiming each stored id's nearest live site
 * within `MATCH_R` (6 m). So an id that stops being generated is a relic a
 * returning player has to find again - and the game says nothing at all when
 * that happens, because `_applyIds` drops an unmatched key silently and on
 * purpose ("the generous direction"). A churned id set is a silently orphaned
 * ledger.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE SET IS FRAGILE, AND WHY STRUCTURAL WORK IS WHAT BREAKS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `Relics._onWorld` builds the site list from two sources and BOTH are
 * downstream of the geometry Phase 7 moves:
 *
 *   1. Authored anchors - `world._towers` and `world._roofs`. The station
 *      publishes no towers and 120 roofs, dealt out through a seeded shuffle
 *      and a per-district round robin. Move a roof and you have moved a relic
 *      id by exactly the distance you moved the roof.
 *   2. A seeded dart pass that samples GROUND HEIGHT - `physics.raycast` down
 *      from y = 400, plus four `groundHeight` probes at r = 4 m for the
 *      `MIN_PROMINENCE` 2.5 test. It reads the geometry-derived collision, so a
 *      structural block that changes what a dart lands on retires that id even
 *      though nobody touched a roof.
 *
 * Worse, the two are COUPLED - through `_tooClose` and through the single
 * `mulberry32(hashString('relic:station'))` stream both draw from. Dropping one
 * authored anchor lets a different one through the 14 m separation test and
 * shifts every subsequent draw from the same generator. There is no such thing
 * as a local change to this set.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  MEASURED, ON THE BUILT STATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   110 sites   107 authored (of 120 published roofs)   3 darted   1 district
 *   minimum XZ separation between sites: 14.3233 m (`MIN_APART` is 14)
 *   site y spans 0.71 m to 164.11 m
 *
 * The count is AT THE CEILING, and that is why identities are pinned rather
 * than a number. `world.bounds` is 1488 m across, so after `EDGE_INSET` the
 * extent is 1444 m, `areaScale` is `min(110/30, (1444/400)^2)` = 3.667 - the
 * `MAX_PER_WORLD` clamp, not the area term - and `want` comes out at exactly
 * 110, with 330 darts to fill it. 120 roofs are offered to a budget of 110. So
 * a re-author can retire a dozen roofs, mint a dozen more, and `placed` stays
 * 110 the whole way: a count assertion here is VACUOUS BY CONSTRUCTION. Only
 * the identities move, and identities are what saves are keyed on.
 *
 * The station tags no `region` and no `ring`, so `districtOf` puts all 107
 * authored anchors in one `core` bucket and the round robin degenerates to the
 * straight walk. If Phase 7 starts tagging districts, the deal order changes
 * and this fixture is expected to churn wholesale - that is a reconciliation,
 * not a regression, and it has to be re-taken and listed.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  DETERMINISM: ASKED AND ANSWERED BY MEASUREMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A pin on a non-deterministic generator is a false pin, and this generator
 * reaches into physics, so it was not assumed. Checked two ways before the
 * fixture was written:
 *
 *   - two `_onWorld` runs against the same built world: identical, 110/110
 *   - two INDEPENDENT `buildStationFresh()` builds in one process: identical,
 *     110/110, zero ids on either side only
 *
 * The first is what the test below re-checks on every run: it is the cheap half
 * and it is the half that catches a generator which starts reading a clock or a
 * shared mutable. The cross-build check is not repeated here - a second station
 * build costs ~9 s - and `station-catalogue.test.mjs` already floors the inputs
 * it proved (`physics.colliders.length` 26771 and the geometry-derived triangle
 * split), which is what a fresh build would re-derive.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THE PIN IS A PIN ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The HEADLESS id set, on the same terms as `station-catalogue.test.mjs` - see
 * the "what headless costs" note in `world-kit.mjs`. Textures are 1x1 black
 * squares and the hero/crowd loaders resolve to empty maps under Node. Neither
 * publishes a roof and neither contributes a collider, and the catalogue pin's
 * diff against the production report (756 names in both, no anchor differing by
 * more than a millimetre) is the evidence that the headless station's structure
 * is the shipped station's structure.
 *
 * Ids are minted through the REAL `idOf`, which is module-private: every site
 * is marked taken and `_upgradeLegacy()` is called - the code path a legacy
 * save takes - and the ids are read back out of the public `serialize()`.
 * Re-implementing the quantisation here would pin this file's idea of an id
 * rather than the game's, and half-metre rounding is exactly the kind of detail
 * a re-implementation gets subtly right and then subtly wrong.
 *
 * To re-take after an INTENDED placement change:
 *     STATION_RELIC_IDS_UPDATE=1 node --test scripts/tests/station-relic-ids.test.mjs
 * and put the printed MINTED/RETIRED diff in the commit message. That diff is
 * the gate: every RETIRED id is a relic some player has already found and is
 * about to be asked to find again.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'station-relic-ids.json');
const UPDATE = process.env.STATION_RELIC_IDS_UPDATE === '1';

/** `StationWorld.id`. The seed is `relic:${id}`, so this string is load-bearing. */
const WORLD_ID = 'station';

/**
 * `MIN_APART` in Relics.js. Not exported, restated here because it is the
 * premise the whole save format rests on: `MATCH_R` only makes stored-key to
 * live-site matching one-to-one while separation stays above twice it.
 */
const MIN_APART = 14;

/* ---------------------------------------------------------------------- */
/* Driving the real generator                                              */
/* ---------------------------------------------------------------------- */

/** The two bus methods `Relics` uses, and nothing else. */
function makeBus() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },
    emit(type, payload) { for (const fn of handlers.get(type) ?? []) fn(payload); },
  };
}

/**
 * One full run of the real placement, driven the way the game drives it.
 *
 * `world:changed` through the bus rather than a direct `_onWorld` call, so the
 * subscription made in the constructor is part of what is under test: a system
 * that stopped listening would place nothing, and this reports zero sites
 * rather than quietly passing.
 *
 * @returns {{ids:string[], sites:THREE.Vector3[], placement:object}}
 */
function place(world, physics) {
  const bus = makeBus();
  const relics = new Relics({
    scene: new THREE.Scene(),
    bus,
    physics,
    player: { position: new THREE.Vector3() },
  });
  bus.emit('world:changed', { id: WORLD_ID, world });

  const sites = relics.sites.map((s) => s.pos.clone());
  /* Mint through the game's own `idOf`. `_upgradeLegacy` is the legacy-save
   * upgrade path: it walks the taken sites, stamps `idOf(site.pos)` into
   * `_foundIds`, and `serialize()` publishes that. Marking every site taken
   * first turns it into "give me every id in this world". */
  for (const s of relics.sites) s.taken = true;
  relics._upgradeLegacy();
  const ids = relics.serialize().foundIds[WORLD_ID] ?? [];

  return { ids, sites, placement: relics.placement };
}

let _run = null;
async function run() {
  if (_run) return _run;
  const { world, physics } = await buildStation();
  /* `buildStation()` is the memoised, read-only world and placement is a
   * reader: it walks `_roofs` and casts against `physics`, and writes only into
   * its own `Relics` instance and its own scene. */
  _run = place(world, physics);
  return _run;
}

/* ---------------------------------------------------------------------- */
/* Tests                                                                   */
/* ---------------------------------------------------------------------- */

test('placement is deterministic within a process', async () => {
  const { world, physics } = await buildStation();
  const a = await run();
  const b = place(world, physics);

  console.log(`  placement: ${JSON.stringify(a.placement)}`);

  /* Set difference rather than `deepEqual` on the two arrays, so a failure
   * NAMES the ids that moved instead of dumping 110 rows twice. `serialize()`
   * sorts, so equal sets are equal arrays and there is no ordering blind spot
   * being hidden by comparing as sets. */
  const A = new Set(a.ids), B = new Set(b.ids);
  const onlyA = a.ids.filter((id) => !B.has(id));
  const onlyB = b.ids.filter((id) => !A.has(id));
  for (const id of onlyA) console.log(`  RUN-1-ONLY  ${id}`);
  for (const id of onlyB) console.log(`  RUN-2-ONLY  ${id}`);

  assert.deepEqual(
    { onlyA, onlyB },
    { onlyA: [], onlyB: [] },
    'two runs of the same generator against the same world placed different relics - the seed is '
    + 'no longer the only input, and NO id set can honestly be pinned until that is fixed'
  );
  assert.equal(b.ids.length, a.ids.length, 'the two runs placed different numbers of relics');
});

test('the set is non-trivially sized', async () => {
  const { ids, placement } = await run();

  /* The failure this floors is one this project has shipped before: a generator
   * that places whatever it manages, logs that number as if it were the target,
   * and passes every assertion that only compares it to itself. `want` is 110
   * and `MAX_PER_WORLD` caps it there, so the band is tight on both sides - a
   * run that placed 40 would still satisfy "more than zero". */
  assert.ok(ids.length >= 100, `only ${ids.length} relic sites placed - the station budgets ${placement?.want ?? '?'}`);
  assert.ok(ids.length <= 110, `${ids.length} sites, over MAX_PER_WORLD 110 - the InstancedMesh silently draws only the first 110`);
  assert.ok((placement?.authored ?? 0) > 0 && (placement?.darted ?? -1) >= 0,
    `placement report missing or authored-empty: ${JSON.stringify(placement)}`);
});

test('no two ids collide, and the separation that makes them ids holds', async () => {
  const { ids, sites } = await run();

  /* A duplicate id is not cosmetic. `_applyIds` claims the nearest UNCLAIMED
   * site per key, so two sites sharing a string would let one stored key
   * restore whichever the loop reached first and leave the other relic
   * permanently un-restorable. */
  assert.equal(new Set(ids).size, ids.length, 'two relic sites minted the same id');

  /* Separation is asserted on the SITE POSITIONS, not on the quantised ids:
   * half-metre rounding can shave up to 0.354 m off a measured distance, so an
   * id-space assertion would need slack that hides the very drift it is for. */
  let min = Infinity;
  let pair = null;
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
      if (d < min) { min = d; pair = [ids[i], ids[j]]; }
    }
  }
  console.log(`  closest pair: ${min.toFixed(4)} m apart (MIN_APART ${MIN_APART}, MATCH_R ${MATCH_R})`);
  assert.ok(min >= MIN_APART, `two sites are ${min.toFixed(3)} m apart, inside MIN_APART ${MIN_APART}: ${pair?.join(' / ')}`);
  /* The invariant the save format rests on, restated where it can fail. */
  assert.ok(MATCH_R < MIN_APART / 2,
    `MATCH_R ${MATCH_R} is no longer under half MIN_APART ${MIN_APART} - id-to-site matching is no longer one-to-one`);
});

test('the relic id set matches the pin', async () => {
  const { ids } = await run();
  const now = [...ids].sort();

  if (UPDATE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`  WROTE ${path.relative(process.cwd(), FIXTURE)} with ${now.length} ids`);
    if (!UPDATE) assert.fail('fixture did not exist and has been written - re-run to assert against it');
    return;
  }

  const was = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const wasSet = new Set(was);
  const nowSet = new Set(now);
  const retired = was.filter((id) => !nowSet.has(id));
  const minted = now.filter((id) => !wasSet.has(id));

  for (const id of retired) console.log(`  RETIRED  ${id}   <- a saved ledger entry for this relic now restores nothing`);
  for (const id of minted) console.log(`  MINTED   ${id}   <- a relic no save has ever seen`);
  if (retired.length || minted.length) {
    console.log(`  ${was.length} pinned -> ${now.length} now  (${retired.length} retired, ${minted.length} minted)`);
  }

  assert.deepEqual(retired, [],
    `${retired.length} relic id(s) retired. Every player who found one of these loses it silently on the next load `
    + '(`_applyIds` drops an unmatched key without a word). If intended, re-take with '
    + 'STATION_RELIC_IDS_UPDATE=1 and list the retired ids in the commit message.');
  assert.deepEqual(minted, [],
    `${minted.length} new relic id(s). If intended, re-take with STATION_RELIC_IDS_UPDATE=1 `
    + 'and list them in the commit message.');
});
