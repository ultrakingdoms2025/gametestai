import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDock } from './world-kit.mjs';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * LODESTAR YARD'S EDITOR ADDRESS SPACE, PINNED — for the same reasons as the
 * station's, and because the yard is the world most likely to be forgotten.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE YARD NEEDS ITS OWN PIN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dock` is a live editable overlay world - site/lib/mapOverlaySchema.ts lists
 * it in `OVERLAY_WORLDS` - so an admin can move, remove and place in it, and
 * every saved entry addresses an object BY NAME exactly as on the station.
 *
 * And the yard does not own its own naming. It mints names through
 * `GeoBatch.flush` in worlds/station/StationKit.js (`yard:<key>`,
 * `ship-<berth>:<key>`, `yard-office:<key>`) and stamps its ramp proxies with
 * `markRampProxy` from the same file. So a change made FOR the station - to
 * the flush seam, to the proxy helper, to what the catalogue withholds - moves
 * the yard's address space too, from a file whose name says "station".
 *
 * That is exactly what happened when this pin was written: the station's name
 * work withheld `ramp-proxy` from the picker, and the yard lost that row as a
 * side effect. Withholding is correct for the yard for the same reason it is
 * correct for the station - one shared string resolving to whichever invisible
 * collision box the traversal reached first - but nothing would have SAID so,
 * and the next re-author of `YardPlan` or `ShipKit` could retire a real
 * `ship-*` address with a fully green suite.
 *
 * To re-take after an INTENDED rename:
 *     DOCK_CATALOGUE_UPDATE=1 node --test scripts/tests/dock-catalogue.test.mjs
 * and put the diff in the commit message.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'dock-catalogue.json');
const UPDATE = process.env.DOCK_CATALOGUE_UPDATE === '1';
const POS_TOL = 0.001;

let _cat = null;
async function catalogue() {
  if (_cat) return _cat;
  const { world } = await buildDock();
  _cat = new MapOverlay({})._catalogue(world);
  return _cat;
}

test('the yard name set and every anchor match the pin', async () => {
  const cat = await catalogue();
  const now = cat.map((o) => ({ name: o.name, position: o.position }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (UPDATE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`  WROTE ${path.relative(process.cwd(), FIXTURE)} with ${now.length} entries`);
    if (!UPDATE) assert.fail('fixture did not exist and has been written - re-run to assert against it');
    return;
  }

  const was = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const wasMap = new Map(was.map((o) => [o.name, o.position]));
  const nowMap = new Map(now.map((o) => [o.name, o.position]));

  const retired = [...wasMap.keys()].filter((n) => !nowMap.has(n));
  const minted = [...nowMap.keys()].filter((n) => !wasMap.has(n));
  const moved = [...nowMap.keys()].filter((n) => wasMap.has(n))
    .map((n) => {
      const a = nowMap.get(n), b = wasMap.get(n);
      return { name: n, dist: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) };
    })
    .filter((m) => m.dist > POS_TOL);

  for (const n of retired) console.log(`  RETIRED  ${n}   <- a saved yard edit targeting this now resolves to nothing`);
  for (const n of minted) console.log(`  MINTED   ${n}`);
  for (const m of moved) console.log(`  ANCHOR   ${m.name}  moved ${m.dist.toFixed(3)} m`);

  assert.deepEqual(retired, [], `${retired.length} yard name(s) retired`);
  assert.deepEqual(minted, [], `${minted.length} new yard name(s)`);
  assert.deepEqual(moved.map((m) => m.name), [], `${moved.length} yard anchor(s) moved`);
});

test('no two nodes in the yard share a name, and no name is a coordinate', async () => {
  const { world } = await buildDock();
  const cat = await catalogue();

  /* Same two invariants the station pins, and for the same reasons: a shared
   * name makes the catalogue and the applier resolve to different nodes (one
   * keeps the shallowest, the other is three's depth-first `getObjectByName`),
   * and a name built out of a rounded position is a measurement rather than an
   * identity - it changes the moment the thing moves.
   *
   * The yard's ship names are `ship-<berth.id>:<key>`, and a berth id is
   * authored, so they are already identities. This asserts that rather than
   * assuming it. */
  const SHARED_BY_DESIGN = new Set(['ramp-proxy']);
  const counts = new Map();
  world.group.traverse((o) => {
    const n = typeof o.name === 'string' ? o.name.trim() : '';
    if (!n || SHARED_BY_DESIGN.has(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });
  assert.deepEqual([...counts].filter(([, n]) => n > 1).map(([k]) => k), [], 'names shared by more than one node in the yard');

  const coordLike = cat.map((o) => o.name).filter((n) => /[-_]{1,2}\d+[-_]{1,2}\d+/.test(n)).sort();
  assert.deepEqual(coordLike, [], 'a yard name encodes a position');
});

test('the yard withholds its ramp proxies from the picker, like the station', async () => {
  const cat = await catalogue();
  const { world } = await buildDock();

  /* The yard gets this from `markRampProxy` in StationKit - one helper for the
   * station, the yard and every ship, so the rule cannot be true in one world
   * and forgotten in another. Asserted here as well as on the station because
   * "shared helper" is a claim about two call sites, and only the call site
   * proves it. */
  assert.deepEqual(cat.filter((o) => o.name === 'ramp-proxy'), [], 'yard ramp proxies are still offered');
  assert.ok(world.group.getObjectByName('ramp-proxy'), 'the proxies should still exist in the world, just not be offered');

  console.log(`  yard catalogue: ${cat.length} named objects`);
  assert.ok(cat.length < 2000, `yard catalogue is ${cat.length}, at or over the cap that truncates silently`);
});
