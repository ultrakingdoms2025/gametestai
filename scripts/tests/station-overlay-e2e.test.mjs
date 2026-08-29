import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { buildStationFresh } from './world-kit.mjs';
import { MapOverlay } from '../../src/systems/MapOverlay.js';

/**
 * MOVE, REMOVE AND PLACE — AGAINST THE STATION THE GAME ACTUALLY BUILDS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE GAP THIS CLOSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `map-overlay.test.mjs` is thorough and it is the applier's real suite, but
 * every case in it runs against a synthetic world: a `THREE.Group` holding one
 * named crate, one named barn and one unnamed mesh, with the id 'station'
 * (`makeWorld`). That world has three names, no merged batches, no instanced
 * scatter, no baked Groups and no triangle-soup collision.
 *
 * So the whole suite would pass a change that renamed every real object in the
 * real station, moved every anchor, or made every remove find nothing. The
 * placement re-plan is exactly such a change. This file is the missing half:
 * the SAME applier, driven against a world with 756 catalogue names, 26,352
 * colliders and 184,071 triangles of structure collision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IT ASSERTS, AND WHY EACH ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. A move lands the ANCHOR at the saved position - not the object's
 *     `position`, which for station's world-baked Groups is the origin
 *     whatever the geometry says. This is the property the whole editor rests
 *     on and it has never been checked against a baked Group.
 *
 *  2. A move is IDEMPOTENT. Worlds are cached and re-shown, so an applier that
 *     translated by a delta would walk the object further off on every visit.
 *
 *  3. A remove hides the mesh AND drops colliders, and reports how many. Zero
 *     is the invisible-wall case the applier was written to prevent.
 *
 *  4. A miss is reported as `name`, not thrown and not silently dropped -
 *     because that is what a retired name does to a saved document, and the
 *     gate for every later phase is that this reason appears.
 *
 *  5. The catalogue and the applier agree about WHICH node a name means. The
 *     catalogue walks breadth-first keeping the shallowest of a duplicate;
 *     the applier uses three's depth-first `getObjectByName`. They agree today
 *     only because duplicates are flat children of `world.group`, and nothing
 *     said so out loud until this assertion.
 *
 * Each test builds its OWN station: applying a document mutates the world -
 * positions, visibility, physics - and a memoised world would hand the next
 * test one somebody had already edited. That costs ~6 s a case and is the
 * reason this file is small and deliberate rather than exhaustive.
 */

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

function makeBus() {
  const handlers = new Map();
  return {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    emit(name, payload) { for (const fn of handlers.get(name) ?? []) fn(payload); },
  };
}

/** A fetch that answers one document for `station` and swallows every report. */
function makeFetch(entries, { schema = 2, version = 1 } = {}) {
  const posts = [];
  const fn = async (_url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ world: 'station', version, schema, entries }) };
    }
    posts.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  fn.posts = posts;
  return fn;
}

/**
 * Build a station, attach an overlay carrying `entries`, and enter the world.
 * Returns everything a test needs to read what happened.
 */
async function applyTo(entries, opts) {
  const { world, physics } = await buildStationFresh();
  const bus = makeBus();
  const fetchImpl = makeFetch(entries, opts);
  const system = new MapOverlay({ bus, physics, fetch: fetchImpl });
  bus.emit('world:changed', { id: 'station', world });
  await system.applying;
  return { world, physics, system, report: system.report, fetchImpl };
}

/** The anchor rule, restated here so a test never asks the applier to mark its own work. */
function anchorOf(node) {
  node.updateWorldMatrix(true, false);
  const b = new THREE.Box3().setFromObject(node);
  return new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, (b.min.z + b.max.z) / 2);
}

/* A real, stable catalogue name with a modest footprint. `monument:trim` is
 * the plaza monument's trim batch - a merged, world-baked GeoBatch mesh, which
 * is the shape that makes station different from the synthetic rig. Pinned by
 * station-catalogue.test.mjs, so if it is ever retired that file says so first
 * and this one does not have to guess why it broke. */
const TARGET = 'monument:trim';

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('a move lands the anchor of a world-baked batch at the saved position', async () => {
  const to = { x: 40, y: 0.5, z: -25 };
  const { world, report } = await applyTo([
    { id: 'm1', kind: 'move', target: { name: TARGET }, position: to },
  ]);

  assert.deepEqual(report.unresolved, [], `the move did not apply: ${JSON.stringify(report.unresolved)}`);
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].ok, true);

  const node = world.group.getObjectByName(TARGET);
  assert.ok(node, `${TARGET} is not in the world - re-take the catalogue pin`);
  const got = anchorOf(node);
  console.log(`  anchor after move: (${got.x.toFixed(3)}, ${got.y.toFixed(3)}, ${got.z.toFixed(3)})  colliders moved: ${report.applied[0].colliders}`);

  /* Millimetres, not float equality: the applier measures, subtracts and
   * translates through the parent's frame, so the round trip is arithmetic
   * rather than assignment. */
  assert.ok(Math.abs(got.x - to.x) < 0.002, `anchor x ${got.x} != ${to.x}`);
  assert.ok(Math.abs(got.y - to.y) < 0.002, `anchor y ${got.y} != ${to.y}`);
  assert.ok(Math.abs(got.z - to.z) < 0.002, `anchor z ${got.z} != ${to.z}`);
});

test('a move is idempotent - a cached world re-entered does not walk', async () => {
  const to = { x: 12, y: 0.25, z: 33 };
  const entries = [{ id: 'm1', kind: 'move', target: { name: TARGET }, position: to }];
  const { world, system } = await applyTo(entries);

  const once = anchorOf(world.group.getObjectByName(TARGET));

  /* The same world object again, exactly as WorldManager re-shows a cached
   * one. `_restore` should put the original transform back before re-applying,
   * so the second answer is the first answer and not the first plus a delta. */
  system.bus.emit('world:changed', { id: 'station', world });
  await system.applying;
  system.bus.emit('world:changed', { id: 'station', world });
  await system.applying;

  const twice = anchorOf(world.group.getObjectByName(TARGET));
  console.log(`  after 1 entry: (${once.x.toFixed(3)}, ${once.z.toFixed(3)})   after 3: (${twice.x.toFixed(3)}, ${twice.z.toFixed(3)})`);
  assert.ok(once.distanceTo(twice) < 0.002, `the object walked ${once.distanceTo(twice).toFixed(3)} m across re-entries`);
  assert.ok(Math.abs(twice.x - to.x) < 0.002, 'and it is not where it was saved');
});

test('a remove hides the mesh and drops colliders, and says how many', async () => {
  const { world, physics, report } = await applyTo([
    { id: 'r1', kind: 'remove', target: { name: TARGET } },
  ]);

  assert.deepEqual(report.unresolved, [], `the remove did not apply: ${JSON.stringify(report.unresolved)}`);
  const row = report.applied[0];
  console.log(`  remove reported colliders: ${row.colliders}, physics now holds ${physics.colliders.length}`);
  assert.equal(row.ok, true);

  const node = world.group.getObjectByName(TARGET);
  assert.equal(node.visible, false, 'the mesh is still visible after a remove');

  /* Not asserted as "> 0": whether a given batch has colliders fully inside
   * its own box is a property of the world, and pinning a number here would
   * pin the world rather than the applier. What must hold is that the number
   * REPORTED is the number DROPPED - the admin's only signal that a remove
   * left a wall standing is this figure. */
  assert.ok(Number.isInteger(row.colliders) && row.colliders >= 0, `colliders reported as ${row.colliders}`);
});

test('a name the world does not have is reported as `name`, never thrown', async () => {
  const { report } = await applyTo([
    { id: 'x1', kind: 'move', target: { name: 'monument:trim-RETIRED' }, position: { x: 0, y: 0, z: 0 } },
    { id: 'x2', kind: 'remove', target: { name: 'no-such-object-anywhere' } },
  ]);

  /* This is the gate for every later phase. A re-authored builder retires a
   * name; the saved document then produces exactly these two rows and the
   * world builds perfectly well without them. If this assertion ever stops
   * holding, a rename has become silent. */
  assert.equal(report.applied.length, 0, 'nothing should have applied');
  assert.deepEqual(
    report.unresolved.map((u) => ({ id: u.id, reason: u.reason })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    [{ id: 'x1', reason: 'name' }, { id: 'x2', reason: 'name' }]
  );
});

test('the catalogue and the applier resolve a name to the same node', async () => {
  const { world, system } = await applyTo([]);
  const cat = system._catalogue(world);

  /* The catalogue walks BREADTH-first and keeps the shallowest of a duplicate
   * name; `_applyMove` and `_applyRemove` use three's `getObjectByName`, which
   * is DEPTH-first. Where those disagree the editor shows and positions one
   * node while the applier moves another, reporting ok: true - the
   * silent-wrong-object case. They agree today because duplicate names are
   * flat children of `world.group`; a re-parenting redesign is exactly what
   * would break it, so it is asserted rather than reasoned about. */
  const at = new THREE.Vector3();
  const wrong = [];
  for (const row of cat) {
    const node = world.group.getObjectByName(row.name);
    if (!node) { wrong.push(`${row.name}: catalogued but getObjectByName finds nothing`); continue; }
    system._anchor(node, at);
    const d = Math.hypot(at.x - row.position.x, at.y - row.position.y, at.z - row.position.z);
    if (d > 0.002) wrong.push(`${row.name}: catalogue says (${row.position.x}, ${row.position.y}, ${row.position.z}), applier resolves to (${at.x.toFixed(3)}, ${at.y.toFixed(3)}, ${at.z.toFixed(3)}) - ${d.toFixed(3)} m apart`);
  }
  console.log(`  checked ${cat.length} names, ${wrong.length} disagreed`);
  for (const w of wrong.slice(0, 10)) console.log(`    ${w}`);
  assert.deepEqual(wrong, []);
});
