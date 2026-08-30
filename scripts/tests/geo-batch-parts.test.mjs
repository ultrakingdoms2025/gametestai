import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installHeadlessDom, THREE } from './world-kit.mjs';
installHeadlessDom();
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');

/**
 * PER-PIECE IDENTITY THROUGH A MERGE.
 *
 * `GeoBatch` merges every authored piece that shares a material into one mesh,
 * and until now that merge was where identity died: no groups, no userData, no
 * way to ask which of the four hundred things in `dressing:hazard` is the
 * barrier standing in a planter. Three placement instruments were built and
 * abandoned on exactly that wall (see the spec, "the root cause of the root
 * causes"), and `StationAudit` counts merged batches out of its own report
 * rather than report one district-sized defect.
 *
 * `flush` now writes `userData.parts`: a start/count pair per authored piece,
 * indexing the merged `geometry.index`.
 *
 * ── THE ASSUMPTION THIS FILE EXISTS TO REFUSE ─────────────────────────────
 *
 * The spans are a running sum of source index counts. That is only correct if
 * `mergeGeometries(list, false)` concatenates indices IN LIST ORDER, and
 * nothing in three.js's contract promises it will keep doing so. So the first
 * case does not check the arithmetic against itself - it rebuilds each piece's
 * bounding box FROM THE MERGED BUFFER through its own span and compares it to
 * where that piece was actually placed. If a three.js upgrade ever reorders or
 * re-indexes a merge, this fails with the boxes swapped, which is the failure
 * you want rather than a silently mis-attributed defect three phases later.
 */

/** A unit box at (x,0,0), 1 m on a side, so each piece has a distinct bbox. */
function boxAt(x) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(x, 0, 0);
  return g;
}

const MATS = { shell: new THREE.MeshBasicMaterial() };

test('a span reproduces the piece that was merged into it', () => {
  const B = new GeoBatch();
  const parent = new THREE.Group();
  /* Three boxes, 10 m apart, so a swapped span is off by 10 m and not by a
   * rounding error. Placed through `at` because that is what every builder
   * uses; `add` is reached no other way. */
  for (const x of [0, 10, 20]) B.at('shell', boxAt(0), x, 0, 0);
  const [mesh] = B.flush(parent, MATS, 'probe');

  const p = mesh.userData.parts;
  assert.ok(p, 'the flushed mesh carries a part table');
  assert.equal(p.start.length, 3, 'one span per authored piece');
  assert.equal(p.indices, mesh.geometry.index.count,
    'the spans account for every index in the merged buffer, with none left over');

  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.index;
  for (let i = 0; i < 3; i++) {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let k = p.start[i]; k < p.start[i] + p.count[i]; k++) {
      box.expandByPoint(v.fromBufferAttribute(pos, idx.getX(k)));
    }
    const c = box.getCenter(new THREE.Vector3());
    assert.ok(Math.abs(c.x - i * 10) < 1e-6,
      `span ${i} recovers the box placed at x=${i * 10}, not ${c.x.toFixed(3)}`);
    assert.ok(Math.abs(box.max.x - box.min.x - 1) < 1e-6, 'and it is one box, not two');
  }
});

test('a single-piece bucket is not merged, and still gets a span', () => {
  /* `flush` short-circuits `mergeGeometries` at length 1. That branch had to
   * be spanned too, and it is the one a naive implementation forgets. */
  const B = new GeoBatch();
  const [mesh] = B.flush.call(
    Object.assign(B, {}), new THREE.Group(), MATS, 'probe',
  ) ?? [];
  assert.equal(mesh, undefined, 'an empty batch flushes nothing');

  const C = new GeoBatch();
  C.at('shell', boxAt(0), 5, 0, 0);
  const [only] = C.flush(new THREE.Group(), MATS, 'probe');
  const p = only.userData.parts;
  assert.equal(p.start.length, 1);
  assert.equal(p.start[0], 0);
  assert.equal(p.count[0], only.geometry.index.count);
});

test('a piece records the build step that raised it', () => {
  /* The owner is read from the world's ambient `_planOwner`, the same field
   * `_solid`/`_solidRot` already read to give a COLLIDER its owner. Reading it
   * at `add` time rather than at construction is what lets one batch span
   * several steps, which `_buildDressing` and the outer ring both do. */
  const world = { _planOwner: 'Stacking the cargo yard' };
  const B = new GeoBatch(world);
  B.at('shell', boxAt(0), 0, 0, 0);
  world._planOwner = 'zone:gym';
  B.at('shell', boxAt(0), 10, 0, 0);
  B._piece = 'bench:3';
  B.at('shell', boxAt(0), 20, 0, 0);

  const p = B.flush(new THREE.Group(), MATS, 'probe')[0].userData.parts;
  assert.deepEqual(
    [...p.ownerOf].map((i) => p.owners[i]),
    ['Stacking the cargo yard', 'zone:gym', 'zone:gym'],
  );
  assert.deepEqual([...p.pieceOf].map((i) => p.pieces[i]), [null, null, 'bench:3']);
  assert.equal(p.owners[0], null, 'entry 0 of the table is null, so unlabelled costs no row');
});

test('a batch built without a world still spans, with no owner', () => {
  /* DockWorld and ShipModel construct bare batches. They must not throw, and
   * they must not silently claim the station's last owner either. */
  const B = new GeoBatch();
  B.at('shell', boxAt(0), 0, 0, 0);
  const p = B.flush(new THREE.Group(), MATS, 'probe')[0].userData.parts;
  assert.equal(p.owners[p.ownerOf[0]], null);
});

/* ─────────────────────────────────────────────────────────────────────────
 * AND THE SAME THING ON THE REAL STATION.
 *
 * The cases above are unit-sized on purpose - three boxes, so a swapped span
 * is legible. These two are the gate: they run against the world as built,
 * where the failure mode is not arithmetic but a builder that quietly stops
 * carrying identity.
 * ───────────────────────────────────────────────────────────────────────── */

const { buildStation } = await import('./world-kit.mjs');
const { collectParts } = await import('../../src/dev/GeoParts.js');

test('every merged batch in the station spans its whole index buffer', async () => {
  const { world } = await buildStation();
  const bad = [];
  let meshes = 0, pieces = 0;
  world.group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.index) return;
    const p = o.userData.parts;
    /* A mesh with no table is not automatically wrong - Interiors and the
     * heightfield build meshes outside GeoBatch - but a mesh whose table does
     * not account for its index buffer IS, because every span past the gap is
     * then attributed to the wrong piece. */
    if (!p) return;
    meshes++;
    pieces += p.start.length;
    if (p.indices !== o.geometry.index.count) {
      bad.push(`${o.name}: spans cover ${p.indices} of ${o.geometry.index.count} indices`);
    }
  });
  assert.deepEqual(bad, [], 'every part table tiles its merged buffer exactly');
  assert.ok(meshes > 400, `expected the station's merged batches to carry tables, got ${meshes}`);
  assert.ok(pieces > 30000,
    `expected tens of thousands of addressable pieces, got ${pieces} - `
    + 'a collapse here means a builder stopped going through GeoBatch');
});

test('no station geometry is raised by an anonymous batch', async () => {
  /* THE REGRESSION THIS FILE EXISTS FOR. `new GeoBatch()` without the world
   * compiles, builds, renders and looks perfectly normal - and every piece it
   * raises is unattributable, which is the exact condition that defeated three
   * placement instruments. It has to fail loudly on the day it is written, not
   * be discovered by a gate that mysteriously stops finding things. */
  const { world } = await buildStation();
  const parts = collectParts(world.group).filter((p) => !p.instanced);
  const orphans = new Map();
  for (const p of parts) {
    if (p.owner === null) orphans.set(p.mesh, (orphans.get(p.mesh) ?? 0) + 1);
  }
  assert.deepEqual([...orphans], [],
    'a merged piece with no owner means its GeoBatch was constructed without the world');
});

test('call-site tracing is OFF unless a tool turns it on', async () => {
  /* THE COST THE GAME MUST NEVER PAY.
   *
   * Capturing a call site is an Error construction per authored piece, and the
   * station authors 37,923 of them - about 700 ms on the build, measured. That
   * is a price a debugging session should pay and a player never should, so the
   * default is off and this asserts it. A leaked `true` would not fail any
   * other test in the suite: the world would build correctly, look identical,
   * and simply be slower for everyone. That is exactly the kind of regression
   * nothing else here would catch. */
  const { world } = await buildStation();
  let traced = 0, total = 0;
  world.group.traverse((o) => {
    const p = o.userData?.parts;
    if (!p?.sites) return;
    total += p.start.length;
    for (let i = 0; i < p.siteOf.length; i++) if (p.sites[p.siteOf[i]]) traced++;
  });
  assert.ok(total > 30000, `expected the station's parts, got ${total}`);
  assert.equal(traced, 0,
    `${traced} of ${total} pieces carry a call site in a normal build - `
    + 'setTraceCallSites(true) has leaked out of a probe and every player is paying for it');
});
