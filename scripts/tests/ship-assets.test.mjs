import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { harness, triangles, raycast, PLAN } from './_hullrig.mjs';

/**
 * THE AUTHORED HULL, AND BOTH ARMS OF THE HULL THAT IS NOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Kestrel's skin is a baked mesh now - `scripts/make-ship-glb.mjs` writes
 * `public/assets/ship/kestrel-hull.glb`, `src/ships/ShipAssets.js` loads it and
 * `Hulls.buildKestrel` draws it instead of 197 boxes. That introduces exactly
 * the two failure modes an asset pipeline always has, and this file is aimed
 * at both:
 *
 * 1. **The asset drifts from the script that made it.** A .glb is a binary
 *    blob: nothing in a diff tells you it was re-exported from somewhere else,
 *    or hand-edited, or built from an older version of the generator. So the
 *    generator is RE-RUN here, into a temp directory, and the bytes are
 *    compared. `make-newel-glb.mjs` established the rule and the maze manifest
 *    states it: "a silently re-exported file cannot drift".
 * 2. **The fallback rots.** `shipParts` returns null under `node --test` - no
 *    `fetch`, no manifest - so every other suite in this repo measures the
 *    PROCEDURAL hull and would stay green if the authored arm never drew
 *    anything at all. The arm the player actually sees therefore has to be
 *    exercised somewhere, and this is the only file that does it: the real
 *    committed .glb is parsed off disk, installed into the loader's cache and
 *    built through the real `buildKestrel`.
 *
 * ── The invariant that matters most ─────────────────────────────────────────
 * The two arms must register IDENTICAL colliders. `ShipBuild.mute` exists so
 * that the authored arm runs the whole procedural shell and suppresses only its
 * drawing; if that ever stops being true, the ship the player walks on and the
 * ship the player sees are different objects, and every climb band, boarding
 * route and reach test in the suite is measuring a hull that is not on screen.
 * Asserted collider by collider, centre and half-extent.
 */

harness();

const { Physics } = await import('../../src/physics/Physics.js');
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
const { ShipBuild, shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
const HULLS_SRC = await import('../../src/worlds/dock/Hulls.js');
const ASSETS = await import('../../src/ships/ShipAssets.js');

const ROOT = path.resolve(process.cwd());
const DIR = path.join(ROOT, 'public/assets/ship');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const ENTRY = MANIFEST.assets.find((a) => a.id === 'kestrel-hull');
const GLB = path.join(DIR, ENTRY.file);

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/* ================================================================== */
/* Parsing the real file, once                                         */
/* ================================================================== */

/**
 * The committed .glb, parsed the way the game parses it.
 *
 * `GLTFLoader.parse` needs no DOM for a file with no images, which is what
 * makes testing the shipped path possible at all here - the loader, the mesh
 * names, the material discard and the winding are all the real ones.
 */
const parsed = await (async () => {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const buf = readFileSync(GLB);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new GLTFLoader();
  return new Promise((res, rej) => loader.parse(ab, DIR, res, rej));
})();

/** id -> [{key, geometry}], the shape `ShipAssets` caches. */
function assetMap() {
  const parts = [];
  parsed.scene.updateMatrixWorld(true);
  parsed.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    parts.push({ key: o.name, geometry: g });
  });
  return { 'kestrel-hull': parts };
}

/* ================================================================== */
/* One hull, either arm                                                */
/* ================================================================== */

function stubMaterials() {
  const M = {};
  for (const k of ['plate', 'steel', 'glass', 'emCyan', 'steelDark', 'grate',
    'hazard', 'crate', 'tarp', 'emAmber', 'emSodium', 'emRed', 'signs']) {
    M[k] = new THREE.MeshStandardMaterial({ name: k });
  }
  return M;
}

/**
 * Build the Kestrel with or without the authored skin.
 *
 * @param {{asset?: boolean, side?: 1|-1}} o
 */
function build(o = {}) {
  ASSETS.resetShipAssets();
  if (o.asset) ASSETS.installShipAssets(assetMap());
  const physics = new Physics();
  const M = stubMaterials();
  const tint = { hull: 0x8894a4, trim: 0x59636f, glass: 0x2a3d52, glow: 0x49d8ff, accent: 0x7d6a52 };
  const { mats } = shipMaterials(M, tint);
  const ext = new GeoBatch();
  const int = new GeoBatch();
  const group = new THREE.Group();
  const b = new ShipBuild({
    batch: ext, interior: int, physics, track: (c) => c, group,
    x: 0, y: 0, z: 0, yaw: 0,
  });
  const result = HULLS_SRC.buildKestrel(b, o.side ?? 1, 1.2, mats);
  const extRoot = new THREE.Group();
  const intRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'arm', {});
  int.flush(intRoot, mats, 'arm-in', {});
  extRoot.updateMatrixWorld(true);
  intRoot.updateMatrixWorld(true);
  ASSETS.resetShipAssets();
  return { b, ext, int, extRoot, intRoot, physics, result, mats };
}

const withAsset = build({ asset: true });
const noAsset = build({ asset: false });

const triCountOf = (root) => {
  let n = 0;
  root.traverse((m) => {
    if (!m.isMesh) return;
    const idx = m.geometry.getIndex();
    n += (idx ? idx.count : m.geometry.attributes.position.count) / 3;
  });
  return n;
};

/* ================================================================== */
/* 1. The manifest, and the file it declares                           */
/* ================================================================== */

test('the manifest declares the file that is actually on disk', () => {
  assert.ok(existsSync(GLB), `${GLB} is missing`);
  assert.equal(ENTRY.kind, 'geometry');
  assert.ok(LICENCES.includes(ENTRY.licence), `licence '${ENTRY.licence}' is not on the allow-list`);
  assert.match(ENTRY.source, /make-ship-glb\.mjs/, 'source must name the generator that made it');
  const bytes = readFileSync(GLB).length;
  assert.equal(bytes, ENTRY.bytes, `manifest says ${ENTRY.bytes} bytes, the file is ${bytes}`);
});

test('the manifest triangle count is the file triangle count', () => {
  let tris = 0;
  parsed.scene.traverse((o) => {
    if (!o.isMesh) return;
    const idx = o.geometry.getIndex();
    tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
  });
  assert.equal(tris, ENTRY.tris, `manifest says ${ENTRY.tris} tris, the file has ${tris}`);
});

test('every mesh in the file is named for a material key the yard has', () => {
  const names = [];
  parsed.scene.traverse((o) => { if (o.isMesh) names.push(o.name); });
  assert.deepEqual(names.slice().sort(), ENTRY.parts.slice().sort(),
    'the manifest `parts` list and the meshes in the file disagree');
  for (const n of names) {
    assert.ok(ASSETS.SHIP_PART_KEYS.includes(n), `mesh '${n}' is not a material key`);
  }
  /* And every key must be one the yard's material set actually answers to, or
   * the bucket flushes with `undefined` and three.js draws it white with a
   * program of its own - which is the one cost this pipeline may not add. */
  for (const n of names) assert.ok(withAsset.mats[n], `no yard material for key '${n}'`);
});

test('every asset id the hull registry names is in the manifest, and vice versa', () => {
  const ids = new Set(MANIFEST.assets.map((a) => a.id));
  for (const id of Object.values(ASSETS.SHIP_ASSET_HULLS)) {
    assert.ok(ids.has(id), `SHIP_ASSET_HULLS names '${id}' and the manifest does not declare it`);
  }
  const claimed = new Set(Object.values(ASSETS.SHIP_ASSET_HULLS));
  for (const id of ids) assert.ok(claimed.has(id), `the manifest declares '${id}' and no hull claims it`);
});

/* ================================================================== */
/* 2. The generator is the file's only author                          */
/* ================================================================== */

test('re-running the generator reproduces the committed file byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ship-glb-'));
  try {
    const out = path.join(dir, 'kestrel-hull.glb');
    execFileSync(process.execPath, ['scripts/make-ship-glb.mjs'], {
      cwd: ROOT, env: { ...process.env, SHIP_GLB_OUT: out }, stdio: 'pipe',
    });
    const a = readFileSync(GLB), c = readFileSync(out);
    assert.equal(c.length, a.length, 'the generator produced a file of a different size');
    assert.ok(a.equals(c), 'the committed .glb is not what the generator produces');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generator holds the plan constants it duplicates', async () => {
  const gen = await import('../../scripts/make-ship-glb.mjs');
  const K = PLAN.KESTREL;
  const P = gen.PLAN;
  assert.equal(P.z0, K.z0); assert.equal(P.z1, K.z1);
  assert.equal(P.bellyY0, K.belly.y0);
  assert.equal(P.lowerHW, K.lower.hw);
  assert.equal(P.ledgeY, K.ledge.y);
  assert.equal(P.roomHW, K.rooms[0].hw);
  assert.equal(P.ceilY, K.rooms[0].ceilY);
  assert.equal(P.spineY, K.spine.y);
  assert.equal(P.upperHW, K.upper.hw);
  assert.deepEqual(P.nacelle, { ...K.nacelle });
  assert.equal(P.hatch.lz, K.hatch.lz);
  assert.equal(P.hatch.w, K.hatch.w);
  assert.equal(P.hatch.h, K.hatch.h);
  assert.equal(P.hatch.sill, K.deck.y);
  assert.equal(P.vtail.rootX, K.vtail.rootX);
  assert.equal(P.vtail.span, K.vtail.span);
});

/* ================================================================== */
/* 3. Both arms build, and only one of them draws boxes                */
/* ================================================================== */

test('the authored arm draws the asset and the procedural arm does not', () => {
  /* Exact counts, and they are the deliverable's own headline numbers:
   *
   *   procedural   9,572 exterior triangles   (+468 interior, unchanged)
   *   authored     7,806 exterior triangles   (+468 interior, unchanged)
   *
   * of which 5,990 are the .glb itself; the rest is the deck plates, the
   * hatch, the gear, the stencil and the two bulkheads both arms draw. The
   * authored hull is LIGHTER than the box hull it replaces, which is the
   * answer to "state your triangle budget and justify it": the budget went
   * down, and every triangle in it is now describing a curve instead of
   * standing a plate on edge.
   *
   * Pinned rather than bounded on purpose. The fallback is not a degraded
   * mode - it is the hull `dock-hulls`, `dock-reach`, `dock-interiors` and
   * `dock-hull-shape` all measure - so a change to it should be a decision
   * somebody made, not a number that drifted. */
  assert.equal(triCountOf(noAsset.extRoot), 9572, 'the procedural hull changed shape');
  assert.equal(triCountOf(withAsset.extRoot), 7806, 'the authored hull changed shape');
  assert.equal(triCountOf(withAsset.intRoot), triCountOf(noAsset.intRoot),
    'the authored skin must not touch the interior');
});

/* ================================================================== */
/* 4. The two arms are the same SHIP                                   */
/* ================================================================== */

test('both arms register the same STRUCTURE, and the differences are named', () => {
  const spec = (c) => {
    const e = c.matrix.elements;
    return [e[12], e[13], e[14], c.halfExtents.x, c.halfExtents.y, c.halfExtents.z]
      .map((v) => Math.round(v * 1e4) / 1e4).join(',');
  };
  const A = withAsset.physics.colliders.filter((c) => c.type === 'box').map(spec).sort();
  const B = noAsset.physics.colliders.filter((c) => c.type === 'box').map(spec).sort();
  const onlyA = A.filter((s) => !B.includes(s));
  const onlyB = B.filter((s) => !A.includes(s));

  /* Everything that carries the ship — plating, decks, bulkheads, the lofts,
   * the pods, the pylons, the fill volumes — is registered by the SAME code on
   * both arms, because `ShipBuild.mute` suppresses drawing and nothing else.
   * There are exactly four deliberate exceptions and they are all named here,
   * by half-extent, so that a fifth one cannot appear quietly.
   *
   *   authored only  the dorsal fin (0.09 x 0.74 x 0.55), which stands where
   *                  the mast used to, and one wing box per side
   *                  (0.35 x 0.27 x 0.85) under a wing longer than the pylon
   *   procedural only  the mast (0.10 x 0.97 x 0.10), and four `relief`
   *                  patches (0.05 x 0.11 x 0.11) — dressing the authored arm
   *                  does not draw, so it does not collide it either
   */
  const halves = (s) => s.split(',').slice(3).join(',');
  const FIN = '0.09,0.74,0.55', WING = '0.35,0.27,0.85';
  const MAST = '0.1,0.97,0.1', PATCH = '0.05,0.11,0.11';
  assert.deepEqual(onlyA.map(halves).sort(), [FIN, WING, WING].sort(),
    `unexpected authored-only colliders:\n${onlyA.join('\n')}`);
  assert.deepEqual(onlyB.map(halves).sort(), [MAST, PATCH, PATCH, PATCH, PATCH].sort(),
    `unexpected procedural-only colliders:\n${onlyB.join('\n')}`);
  /* And the shared set is the whole of the structure: 60 boxes. */
  assert.equal(A.length - onlyA.length, 60);
});

test('both arms publish the same rooms, doors and boarding point', () => {
  assert.deepEqual(withAsset.result.rooms, noAsset.result.rooms);
  assert.equal(withAsset.b.doors.length, noAsset.b.doors.length);
  assert.equal(withAsset.b.apertures.length, noAsset.b.apertures.length);
  assert.deepEqual(withAsset.b.apertures, noAsset.b.apertures);
  assert.equal(withAsset.result.door.id, noAsset.result.door.id);
});

test('the authored arm still records where its engines exhaust', () => {
  /* `ShipModel` hangs the flown hull's plume off `nozzles`; a hull with none
   * burns nothing under throttle and nobody notices in a screenshot. */
  assert.equal(withAsset.b.nozzles.length, 2);
  for (const nz of withAsset.b.nozzles) {
    assert.ok(nz.r > 0.2, 'a plume needs a radius');
    assert.ok(Math.abs(nz.lz - PLAN.KESTREL.nacelle.z0) < 0.25,
      `the plume starts at z ${nz.lz}, the pod's exit plane is ${PLAN.KESTREL.nacelle.z0}`);
    assert.ok(Math.abs(Math.abs(nz.lx) - 3.80) < 0.01, 'the plume is not on the pod centreline');
  }
});

/* ================================================================== */
/* 5. The doorway is a hole in the authored skin too                   */
/* ================================================================== */

/**
 * Fire a fan of rays from outside the flank into the compartment, through the
 * boarding aperture, and count what gets through.
 *
 * `dock-hull-shape.test.mjs` does this to the procedural hull and its header
 * records what it found the first time: 80 of 81 samples blocked, by relief
 * patches and a berth stencil laid over the doorway. An authored skin is one
 * surface with a hole cut in it, so the question is whether the hole is where
 * the plan says the door is - a hole in the wrong place passes every geometry
 * test ever written and traps the player outside their own ship.
 */
function apertureBlocked(rec, side) {
  const soup = triangles([rec.extRoot, rec.intRoot]);
  const H = PLAN.KESTREL;
  const x0 = side * (H.lower.hw + 1.6);
  let blocked = 0, total = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const z = H.hatch.lz + (i / 8 - 0.5) * (H.hatch.w - 0.24);
      const y = H.deck.y + 0.12 + (j / 8) * (H.hatch.h - 0.30);
      const hit = raycast(soup, x0, y, z, -side, 0, 0, 1.6 + 0.6);
      total++;
      if (hit) blocked++;
    }
  }
  return { blocked, total };
}

test('the boarding aperture is a hole in the authored skin', () => {
  const r = apertureBlocked(withAsset, 1);
  assert.equal(r.blocked, 0, `${r.blocked} of ${r.total} rays through the doorway were stopped`);
});

test('the skin is solid where the doorway is not', () => {
  /* The complement, and it is the assertion that makes the one above mean
   * something: a skin with no flank at all would pass an aperture probe
   * perfectly. Fired at the same height, 3 m forward of the hatch. */
  const soup = triangles([withAsset.extRoot]);
  const H = PLAN.KESTREL;
  let hits = 0;
  for (let j = 0; j < 5; j++) {
    const y = H.deck.y + 0.3 + j * 0.35;
    if (raycast(soup, H.lower.hw + 1.6, y, H.hatch.lz + 3.0, -1, 0, 0, 2.2)) hits++;
  }
  assert.equal(hits, 5, 'the flank forward of the hatch is not solid');
});

test('the aperture follows the boarding side', () => {
  /* The .glb is authored with the hole to starboard and mirrored by the loader
   * for a hull that boards to port - which is every berth in this yard
   * (`boardSide` returns -1 for all three walkable hulls). A mirror that did
   * not flip the winding would cull the whole hull; a mirror that never
   * happened would put the door on the wrong flank. */
  const port = build({ asset: true, side: -1 });
  const open = apertureBlocked(port, -1);
  assert.equal(open.blocked, 0, `${open.blocked} of ${open.total} rays through the port doorway were stopped`);
  const shut = apertureBlocked(port, 1);
  assert.ok(shut.blocked > shut.total * 0.8,
    `the starboard flank has a hole in it: only ${shut.blocked} of ${shut.total} rays were stopped`);
});

/* ================================================================== */
/* 6. The skin stays outside the rooms                                 */
/* ================================================================== */

test('no authored triangle intrudes into a compartment', () => {
  /* The compartment envelope is a contract in `HullPlan` and the skin is drawn
   * from a table of curves that has no idea the rooms are there. Inset by 0.02
   * so a skin that lands exactly ON the room's face is not counted as through
   * it - the cabin lining is 0.06 m inboard of the plating and that is where
   * the tolerance comes from. */
  const parts = assetMap()['kestrel-hull'];
  const H = PLAN.KESTREL;
  let inside = 0;
  let worst = null;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      for (const r of H.rooms) {
        if (Math.abs(x) < r.hw - 0.02 && y > r.floorY + 0.02 && y < r.ceilY - 0.02
          && z > r.z0 + 0.02 && z < r.z1 - 0.02) {
          inside++;
          worst = `${p.key} at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) is inside '${r.id}'`;
        }
      }
    }
  }
  assert.equal(inside, 0, worst ?? '');
});

test('the authored skin covers the beam and the length the plan promises', () => {
  const parts = assetMap()['kestrel-hull'];
  const H = PLAN.KESTREL;
  let minZ = Infinity, maxZ = -Infinity, maxX = 0, maxY = -Infinity, minY = Infinity;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      minZ = Math.min(minZ, pos.getZ(i)); maxZ = Math.max(maxZ, pos.getZ(i));
      maxX = Math.max(maxX, Math.abs(pos.getX(i)));
      minY = Math.min(minY, pos.getY(i)); maxY = Math.max(maxY, pos.getY(i));
    }
  }
  assert.ok(maxZ >= H.nose.z1 - 0.01 && maxZ <= H.nose.z1 + 0.01, `nose tip at z ${maxZ}, plan says ${H.nose.z1}`);
  assert.ok(minZ <= H.nacelle.z0 + 0.01, `nothing reaches the pods' exit plane: aft-most is z ${minZ}`);
  assert.ok(maxX >= H.nacelle.x1 - 0.05, `beam over the pods is ${maxX}, plan says ${H.nacelle.x1}`);
  /* Nothing below the cradle's bearing face, or the hull is drawn through the
   * saddles it is standing on. The chine strake is the lowest thing on it. */
  assert.ok(minY >= PLAN.SADDLE_TOP - 0.05, `the skin reaches y ${minY}, the saddles bear at ${PLAN.SADDLE_TOP}`);
  assert.ok(maxY <= H.spine.y + 1.4, `something stands ${maxY - H.spine.y} m over the spine deck`);
});

/* ================================================================== */
/* 7. Degradation                                                      */
/* ================================================================== */

test('shipParts returns null when nothing is loaded, and the hull still builds', () => {
  ASSETS.resetShipAssets();
  assert.equal(ASSETS.shipParts('kestrel'), null);
  assert.equal(ASSETS.shipParts('dray'), null, 'no other hull has an asset yet');
  const rec = build({ asset: false });
  assert.ok(triCountOf(rec.extRoot) > 6000);
});

test('a manifest entry whose file never arrives leaves the map empty', async () => {
  /* The loader's own failure path, driven with a fetch that 404s - which is
   * what a renamed file, a bad deploy or an offline CDN looks like from here.
   * It must resolve, not reject: a yard that throws because a decorative mesh
   * is missing is worse than a yard with a boxy ship in it. */
  ASSETS.resetShipAssets();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('manifest.json')
    ? { ok: true, json: async () => MANIFEST }
    : { ok: false, status: 404 });
  try {
    const map = await ASSETS.loadShipAssets();
    assert.deepEqual(map, {});
    assert.equal(ASSETS.shipParts('kestrel'), null);
  } finally {
    globalThis.fetch = realFetch;
    ASSETS.resetShipAssets();
  }
});

test('the four hulls are fetched at once, and every request can be abandoned', async () => {
  /* ═══════════════════════════════════════════════════════════════════════
   *  TWO PROPERTIES OF THE SAME LOOP, AND BOTH WERE WRONG
   * ═══════════════════════════════════════════════════════════════════════
   *
   * 1. IT WAS SERIAL. `for (const entry of entries) { await fetch(...) }`,
   *    inherited from `MazeAssets.js` — where it is right, because that
   *    manifest holds ONE 12 KB prop. Here it is four files totalling
   *    1,188,228 bytes on `DockWorld.build`'s awaited critical path, so the
   *    inherited shape is a 100x amplification rather than a copy. Measured in
   *    the live page against this repo's dev server: 222 ms serial, 107 ms
   *    parallel on a ZERO-latency loopback, and every millisecond of real RTT
   *    is paid three extra times by the serial arm.
   *
   * 2. NOTHING COULD BE ABANDONED. The header promises "every failure path
   *    resolves". A stall is not a failure path: `fetch` never settles,
   *    `loadAll` never returns, and the player sits on a loading screen with a
   *    working procedural fallback one `catch` away. Every request now carries
   *    an `AbortSignal` with a timeout, which turns the stall into the error
   *    the existing `catch` already degrades from.
   *
   * Driven, not grepped: the stub counts how many hull fetches are in flight
   * at once and records the options it was handed. Peak in-flight was 1 before
   * and must be the whole manifest now.
   */
  ASSETS.resetShipAssets();
  const realFetch = globalThis.fetch;
  const hulls = MANIFEST.assets.filter((a) => a.kind === 'geometry');
  let live = 0, peak = 0;
  const signals = [];
  globalThis.fetch = async (url, opts) => {
    signals.push(opts?.signal ?? null);
    if (String(url).endsWith('manifest.json')) return { ok: true, json: async () => MANIFEST };
    live++;
    peak = Math.max(peak, live);
    /* Two macrotask hops, so a serial loop cannot accidentally overlap: each
     * arm has to be started before any of them finishes for `peak` to rise. */
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    live--;
    return { ok: false, status: 503 };
  };
  try {
    await ASSETS.loadShipAssets();
    assert.equal(peak, hulls.length,
      `only ${peak} of the ${hulls.length} hull files were ever in flight together - the loader is serialising `
      + `${(hulls.reduce((n, a) => n + a.bytes, 0) / 1024).toFixed(0)} KB on the yard's critical path`);
    assert.equal(signals.length, hulls.length + 1, 'the manifest and every hull must be fetched exactly once');
    const naked = signals.filter((s) => !s || typeof s.aborted !== 'boolean');
    assert.equal(naked.length, 0,
      `${naked.length} of ${signals.length} requests carried no AbortSignal - a stalled connection would hold `
      + 'the world build open for ever, and "every failure path resolves" would be false');
  } finally {
    globalThis.fetch = realFetch;
    ASSETS.resetShipAssets();
  }
});

test('a missing manifest is not an error either', async () => {
  ASSETS.resetShipAssets();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    assert.deepEqual(await ASSETS.loadShipAssets(), {});
  } finally {
    globalThis.fetch = realFetch;
    ASSETS.resetShipAssets();
  }
});

test('asset URLs are built from the Vite base, never from an absolute path', () => {
  /* The same grep `maze-assets.test.mjs` runs on `MazeAssets.js`, for the same
   * reason: this game is served under /game/, so a leading-slash asset path
   * works in dev and 404s for every player. */
  const src = readFileSync(path.join(ROOT, 'src/ships/ShipAssets.js'), 'utf8');
  assert.ok(/import\.meta\.env\s*&&\s*import\.meta\.env\.BASE_URL/.test(src),
    'ShipAssets must read BASE_URL');
  const bad = src.match(/(['"`])\/assets\/ship\//g);
  assert.equal(bad, null, 'an absolute /assets/ship/ path would 404 under the /game/ base');
});

/* ================================================================== */
/* 8. The program budget                                               */
/* ================================================================== */

test('the authored hull adds no material, and therefore no shader program', () => {
  /* `MazeAssets.firstGeometry` records the trap this repeats: a glTF material
   * is its own program family. The loader must hand back geometry and nothing
   * else, and every bucket the hull flushes must be a key the yard's own
   * material set already answers to.
   *
   * Measured on the built arms rather than argued: the set of material
   * instances used by the authored hull must be a SUBSET of the procedural
   * hull's, because a new instance with different defines is a new compile. */
  const used = (root) => {
    const set = new Set();
    root.traverse((m) => { if (m.isMesh) set.add(m.material?.name ?? '(none)'); });
    return set;
  };
  const a = used(withAsset.extRoot), p = used(noAsset.extRoot);
  for (const name of a) {
    assert.notEqual(name, '(none)', 'a bucket flushed with no material');
    assert.ok(p.has(name), `the authored hull draws with '${name}', which the procedural hull never had`);
  }
  /* And nothing in the file was allowed to bring its own. */
  for (const p2 of assetMap()['kestrel-hull']) {
    assert.equal(p2.geometry.attributes.position.itemSize, 3);
    assert.ok(p2.geometry.getAttribute('normal'), 'a part with no normals shades flat black');
    assert.ok(p2.geometry.getAttribute('uv'), 'a part with no uvs samples the plating map at 0,0');
  }
});

test('no authored vertex carries a non-finite number', () => {
  /* One NaN texture coordinate is not a few bad pixels: `UnrealBloomPass`
   * high-passes the frame and blurs the result through five mip levels, so the
   * additive composite writes NaN over every pixel on screen. This hull did
   * exactly that on its first build in the browser - 148 NaN uvs from a patch
   * that wrapped past the end of its own arc-length table - and rendered a
   * white screen with a ship-shaped hole in it. `ShipBuild._tile` guards the
   * box path; this guards the authored one. */
  for (const p of assetMap()['kestrel-hull']) {
    for (const name of ['position', 'normal', 'uv']) {
      const a = p.geometry.getAttribute(name).array;
      for (let i = 0; i < a.length; i++) {
        assert.ok(Number.isFinite(a[i]), `${p.key}.${name}[${i}] is ${a[i]}`);
      }
    }
  }
});
