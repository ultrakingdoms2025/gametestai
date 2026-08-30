import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStation, THREE } from './world-kit.mjs';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * WHAT A MOVE WOULD DRAG, PINNED PER NAME.
 *
 * Phase 7's per-release gate asks that "a move of the largest name reports a
 * `colliders` count within one chunk of the previous release". Nothing measured
 * it. `station-overlay-e2e.test.mjs:165` deliberately refuses to - "pinning a
 * number here would pin the world rather than the applier" - which is right for
 * that file and leaves the world side unpinned by anything.
 *
 * This is the world side. For every catalogue name it records what
 * `_moveColliders` WOULD take, without taking it, and diffs the whole table
 * against a fixture. Re-take with:
 *
 *     STATION_MOVE_COLLIDERS_UPDATE=1 node --test scripts/tests/station-move-colliders.test.mjs
 *
 * ── Why an exact table and not a tolerance ────────────────────────────────
 *
 * "Within one chunk" has no meaning on this side: chunks are how structure
 * collision is packed, and what a move drags is a count of collider objects.
 * A table diff says exactly which names changed and by how much, which is what
 * a release note needs; a tolerance would let a name drift every release until
 * it had doubled. The catalogue pin next door works the same way and for the
 * same reason.
 *
 * ── The three outcomes, and the one that is a defect ──────────────────────
 *
 *   n >= 0   the count the applier would move.
 *   -1       refused: nothing owns the name, the geometric guess exceeded the
 *            cap, and the move reports `span`. Nothing moves, the admin is
 *            told. This is a safe outcome and a stable one worth pinning.
 *
 * A name going from a number to -1 means an object that could be dragged no
 * longer can. A name going from -1 to a number means a district-scale drag
 * became possible. Both are release-note material; neither is caught by
 * anything else.
 *
 * ── Re-taken 2026-08-30: two nudges, three names, one collider each ──────
 *
 *   gateway-medieval:plaza    38 -> 37
 *   gateway-medieval:emAmber  90 -> 89
 *   habitat:emGreen           16 -> 15
 *
 * `StationPlan` stopped rasterising its corridors and found three claims
 * standing in a carriageway that the raster could not see. Fixing them moved
 * two pieces of geometry, and this table is where that shows up as drag:
 *
 *   the gateway approach's parked freight moved 2 m perpendicular to avenue 60
 *   (mirrored to 300), which takes one collider out of each of the two
 *   gateway-medieval drag sets it was sitting in;
 *   the habitat terrace's planter ring went 12 m to 11 m, taking one lit
 *   sphere out of the `habitat:emGreen` set.
 *
 * Three names, one collider each, and no name crossed the -1 boundary - which
 * is the outcome this table exists to distinguish a real change from.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'station-move-colliders.json');
const UPDATE = process.env.STATION_MOVE_COLLIDERS_UPDATE === '1';

/** Mirrors `_moveColliders`' own cap. Kept local so a change there shows up. */
const CAP = 200;

test('what a move would drag has not changed for any name', async () => {
  const { world, physics } = await buildStation();
  const overlay = new MapOverlay({ physics });
  const box = new THREE.Box3();

  /* Walk the scene rather than the catalogue fixture, so this file does not
   * silently measure whatever the other pin happens to hold. */
  const seen = new Set();
  const now = {};
  world.group.traverse((o) => {
    if (!o.name || seen.has(o.name)) return;
    seen.add(o.name);
    o.updateWorldMatrix(true, false);
    box.setFromObject(o);
    if (box.isEmpty()) return;

    const owned = overlay._collidersOwnedBy(o.name);
    if (owned) { now[o.name] = owned.length; return; }

    /* The geometric guess, replicated rather than called: `_moveColliders`
     * MUTATES what it claims, so the only branch safe to invoke here is the
     * refusal. Everything else is counted the way the applier counts it. */
    let n = 0;
    for (const c of physics.colliders) {
      if (!c || c.type === 'heightfield') continue;
      if (box.containsPoint(c.center)) n++;
      if (n > CAP) break;
    }
    now[o.name] = n > CAP ? -1 : n;
  });

  const count = Object.keys(now).length;
  const owned = Object.values(now).filter((n) => n > 0).length;
  const refused = Object.values(now).filter((n) => n === -1).length;
  console.log(`  ${count} named nodes; ${owned} would move colliders, ${refused} would refuse with span`);

  if (UPDATE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`  WROTE ${path.relative(process.cwd(), FIXTURE)} with ${count} names`);
    if (!UPDATE) assert.fail('fixture did not exist and has been written - re-run to assert against it');
    return;
  }

  const was = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const changed = [];
  for (const [name, n] of Object.entries(now)) {
    if (!(name in was)) { changed.push(`MINTED  ${name} would move ${n}`); continue; }
    if (was[name] !== n) changed.push(`${name}: ${was[name]} -> ${n}`);
  }
  for (const name of Object.keys(was)) {
    if (!(name in now)) changed.push(`RETIRED ${name} (was ${was[name]})`);
  }
  for (const c of changed) console.log(`  ${c}`);

  assert.deepEqual(changed, [],
    `${changed.length} name(s) changed what a move would drag. A rise means one click now carries more `
    + 'collision than it did; a fall means a wall may be left behind. If intended, re-take the fixture '
    + 'with STATION_MOVE_COLLIDERS_UPDATE=1 and list the deltas in the commit.');
});
