import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { harness, triangles, raycast, triCount, PLAN, CRADLE_TOP } from './_hullrig.mjs';

/**
 * THE AUTHORED PIKE, AND BOTH ARMS OF THE HULL THAT IS NOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/make-ship-glb.mjs SHIP_GLB_HULL=pike` writes
 * `public/assets/ship/pike-hull.glb`, `src/ships/ShipAssets.js` loads it, and
 * `Hulls.buildPike` draws it instead of the plated sections, the six-facet
 * nose cone and the rectangular sponsons. That introduces the two failure
 * modes an asset pipeline always has, and this file is aimed at both — the
 * same two `ship-assets.test.mjs` names for the Kestrel:
 *
 * 1. **The asset drifts from the script that made it.** A .glb is a binary
 *    blob and nothing in a diff says it was re-exported, hand-edited or built
 *    from an older generator. So the generator is RE-RUN here into a temp
 *    directory and the bytes are compared.
 * 2. **The fallback rots.** `shipParts` returns null under `node --test` — no
 *    `fetch`, no manifest — so `dock-hulls`, `dock-reach`, `dock-interiors`
 *    and `dock-hull-shape` all measure the PROCEDURAL Pike and would stay
 *    green if the authored arm never drew anything at all. The arm the player
 *    sees is exercised here and nowhere else.
 *
 * ── The invariant that matters most ─────────────────────────────────────────
 * The two arms must register the same colliders bar a NAMED list.
 * `ShipBuild.mute` exists so the authored arm runs the whole procedural shell
 * and suppresses only its drawing; if that stops being true, the ship the
 * player walks on and the ship the player sees are different objects and every
 * climb band, boarding route and reach test in the suite is measuring a hull
 * that is not on screen.
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
const ENTRY = MANIFEST.assets.find((a) => a.id === 'pike-hull');
const GLB = path.join(DIR, ENTRY.file);
const H = PLAN.PIKE;

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/* ================================================================== */
/* Parsing the real file, once                                         */
/* ================================================================== */

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
  return { 'pike-hull': parts };
}

/**
 * The baked mesh as a ray-castable soup, optionally one part of it.
 *
 * Fired at the ASSET rather than at the assembled hull wherever the question
 * is about the mesh itself. Both arms lay dressing over this skin — the mantle
 * stripe stands 0.04 m proud of the wing, the interior trunk wall stands
 * inboard of the flank — and a probe that meets one of those is answering a
 * true question about a different object.
 */
function assetSoup(only) {
  const g = new THREE.Group();
  for (const p of assetMap()['pike-hull']) {
    if (only && p.key !== only) continue;
    const m = new THREE.Mesh(p.geometry);
    m.name = p.key;
    g.add(m);
  }
  g.updateMatrixWorld(true);
  return triangles([g]);
}

/** Every authored vertex, as flat triples, with the part key beside it. */
function authoredVerts() {
  const out = [];
  for (const p of assetMap()['pike-hull']) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) out.push([p.key, pos.getX(i), pos.getY(i), pos.getZ(i)]);
  }
  return out;
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

/** @param {{asset?: boolean, side?: 1|-1}} o */
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
  const result = HULLS_SRC.buildPike(b, o.side ?? 1, CRADLE_TOP.pike, mats);
  const extRoot = new THREE.Group();
  const intRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'arm', {});
  int.flush(intRoot, mats, 'arm-in', {});
  extRoot.updateMatrixWorld(true);
  intRoot.updateMatrixWorld(true);
  ASSETS.resetShipAssets();
  return { b, ext, int, extRoot, intRoot, physics, result, mats, group };
}

const withAsset = build({ asset: true });
const noAsset = build({ asset: false });

/* ================================================================== */
/* 1. The manifest, and the file it declares                           */
/* ================================================================== */

test('the manifest declares the file that is actually on disk', () => {
  assert.ok(existsSync(GLB), `${GLB} is missing`);
  assert.equal(ENTRY.kind, 'geometry');
  assert.equal(ENTRY.hull, 'pike');
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

test('every mesh in the Pike file is named for a material key the yard has', () => {
  const names = [];
  parsed.scene.traverse((o) => { if (o.isMesh) names.push(o.name); });
  assert.deepEqual(names.slice().sort(), ENTRY.parts.slice().sort(),
    'the manifest `parts` list and the meshes in the file disagree');
  for (const n of names) assert.ok(ASSETS.SHIP_PART_KEYS.includes(n), `mesh '${n}' is not a material key`);
  /* And every key must be one the yard's material set answers to, or the
   * bucket flushes with `undefined` and three.js draws it white with a program
   * of its own — the one cost this pipeline may not add. */
  for (const n of names) assert.ok(withAsset.mats[n], `no yard material for key '${n}'`);
});

test('the Pike claims its asset id and the manifest declares it', () => {
  assert.equal(ASSETS.SHIP_ASSET_HULLS.pike, 'pike-hull');
  assert.ok(MANIFEST.assets.some((a) => a.id === 'pike-hull'));
});

/* ================================================================== */
/* 2. The generator is the file's only author                          */
/* ================================================================== */

test('re-running the generator reproduces the committed Pike byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pike-glb-'));
  try {
    const out = path.join(dir, 'pike-hull.glb');
    execFileSync(process.execPath, ['scripts/make-ship-glb.mjs'], {
      cwd: ROOT,
      env: { ...process.env, SHIP_GLB_HULL: 'pike', SHIP_GLB_OUT: out },
      stdio: 'pipe',
    });
    const a = readFileSync(GLB), c = readFileSync(out);
    assert.equal(c.length, a.length, 'the generator produced a file of a different size');
    assert.ok(a.equals(c), 'the committed pike-hull.glb is not what the generator produces');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Pike generator holds the plan constants it duplicates', async () => {
  const gen = await import('../../scripts/make-ship-glb.mjs');
  const P = gen.PIKE_PLAN;
  assert.equal(P.z0, H.z0); assert.equal(P.z1, H.z1);
  assert.equal(P.bellyY0, H.belly.y0);
  assert.equal(P.lowerHW, H.lower.hw);
  assert.equal(P.ledgeY, H.ledge.y);
  assert.equal(P.roomHW, H.rooms[0].hw);
  assert.equal(P.ceilY, H.rooms[0].ceilY);
  assert.equal(P.spineY, H.spine.y);
  assert.equal(P.upperHW, H.upper.hw);
  for (const k of ['x0', 'x1', 'y0', 'y1', 'leadRoot', 'trailRoot', 'leadTip', 'trailTip', 'botRoot', 'botTip']) {
    assert.equal(P.wing[k], H.wing[k], `wing.${k}`);
  }
  assert.deepEqual({ ...P.fin }, { ...H.fin });
  assert.deepEqual({ ...P.cannon }, { ...H.cannon });
  assert.equal(P.hatch.lz, H.hatch.lz);
  assert.equal(P.hatch.w, H.hatch.w);
  assert.equal(P.hatch.h, H.hatch.h);
  assert.equal(P.hatch.sill, H.deck.y);
});

/* ================================================================== */
/* 3. Both arms build, and only one of them draws boxes                */
/* ================================================================== */

test('the authored arm draws the asset and the procedural arm does not', () => {
  /* Exact counts, and they are the deliverable's own headline numbers:
   *
   *   procedural   12,660 exterior triangles   (+756 interior, unchanged)
   *   authored     10,046 exterior triangles   (+756 interior, unchanged)
   *
   * of which 7,102 are the .glb itself; the rest is the two deck plates, the
   * hatch and its leaves, the landing gear, the berth stencil, the hazard
   * stripes, the deck detail and the interior bulkheads both arms draw. The
   * authored hull is LIGHTER than the box hull it replaces, which is the
   * answer to "state your triangle count against the current one": it went
   * DOWN by 2,614, and every triangle in it now describes a curve instead of
   * standing a plate on edge. The dressing it drops — 156 relief patches, two
   * grids of panel lines, the faceted nose cone, the sponson lofts, the
   * cylinder barrels and the two engine bells — cost more than the mesh.
   *
   * Pinned rather than bounded on purpose. The fallback is not a degraded
   * mode; it is the hull four other suites measure. */
  assert.equal(triCount(noAsset.extRoot), 12660, 'the procedural hull changed shape');
  assert.equal(triCount(withAsset.extRoot), 10046, 'the authored hull changed shape');
  assert.equal(triCount(withAsset.intRoot), triCount(noAsset.intRoot),
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

  /* Everything that carries the ship — plating, decks, bulkheads, the keel
   * loft, the wings, the struts, the fin, the fill volumes — is registered by
   * the SAME code on both arms, because `ShipBuild.mute` suppresses drawing
   * and nothing else. There are exactly two deliberate groups of exception and
   * they are named here, by half-extent, so a third cannot appear quietly.
   *
   *   authored only  three nose boxes inscribed in the BLADE (the procedural
   *                  nose is 4.50 m across at its root and this one is 2.84),
   *                  and two canopy boxes under a blister that stands 1.58 m
   *                  over a deck the flat glass plate never rose off
   *   procedural only  five nose boxes inscribed in the cone, and the 17
   *                  `relief` patches — dressing the authored arm does not
   *                  draw, so it does not collide it either
   */
  const halves = (s) => s.split(',').slice(3).join(',');
  const NOSE_A = ['1.42,0.625,0.6', '0.76,0.435,0.6', '0.1,0.1,0.85'];
  const CANOPY_A = ['1.25,0.45,0.65', '1.19,0.1,0.65'];
  const NOSE_B = ['1.95,0.92,0.5', '1.42,0.73,0.45', '0.92,0.51,0.45', '0.5,0.3,0.35', '0.13,0.1,0.3'];
  const PATCH = '0.05,0.11,0.11';
  assert.deepEqual(onlyA.map(halves).sort(), [...NOSE_A, ...CANOPY_A].sort(),
    `unexpected authored-only colliders:\n${onlyA.join('\n')}`);
  assert.deepEqual(onlyB.map(halves).sort(), [...NOSE_B, ...new Array(17).fill(PATCH)].sort(),
    `unexpected procedural-only colliders:\n${onlyB.join('\n')}`);
  /* And the shared set is the whole of the structure: 67 boxes. */
  assert.equal(A.length - onlyA.length, 67);
});

test('both arms publish the same rooms, doors and boarding point', () => {
  assert.deepEqual(withAsset.result.rooms, noAsset.result.rooms);
  assert.equal(withAsset.b.doors.length, noAsset.b.doors.length);
  assert.deepEqual(withAsset.b.apertures, noAsset.b.apertures);
  assert.equal(withAsset.result.door.id, noAsset.result.door.id);
  assert.equal(withAsset.result.ramp.length ?? 0, noAsset.result.ramp.length ?? 0);
});

test('the authored arm still records where its engines exhaust', () => {
  /* `ShipModel` hangs the flown hull's plume off `nozzles`; a hull with none
   * burns nothing under throttle and nobody notices in a screenshot. `bell()`
   * is what records it and it is called while MUTED on this arm, so the two
   * arms agree exactly - the authored throat is drawn on the same axis. */
  assert.deepEqual(withAsset.b.nozzles, noAsset.b.nozzles);
  assert.equal(withAsset.b.nozzles.length, 2);
  for (const nz of withAsset.b.nozzles) {
    assert.ok(nz.r > 0.2, 'a plume needs a radius');
    assert.ok(Math.abs(Math.abs(nz.lx) - 1.05) < 0.01, 'the plume is not on the engine centreline');
  }
});

/* ================================================================== */
/* 5. The doorway is a hole in the authored skin too                   */
/* ================================================================== */

function apertureBlocked(rec, side) {
  const soup = triangles([rec.extRoot, rec.intRoot]);
  const x0 = side * (H.lower.hw + 1.6);
  let blocked = 0, total = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const z = H.hatch.lz + (i / 8 - 0.5) * (H.hatch.w - 0.24);
      const y = H.deck.y + 0.12 + (j / 8) * (H.hatch.h - 0.40);
      if (raycast(soup, x0, y, z, -side, 0, 0, 1.6 + 0.6)) blocked++;
      total++;
    }
  }
  return { blocked, total };
}

test('the boarding aperture is a hole in the authored skin', () => {
  const r = apertureBlocked(withAsset, 1);
  assert.equal(r.blocked, 0, `${r.blocked} of ${r.total} rays through the doorway were stopped`);
});

test('the skin is solid where the doorway is not', () => {
  /* The complement, and it is what makes the assertion above mean something:
   * a skin with no flank at all would pass an aperture probe perfectly. Fired
   * at the same heights, 2.6 m forward of the hatch. */
  const soup = triangles([withAsset.extRoot]);
  let hits = 0;
  for (let j = 0; j < 5; j++) {
    const y = H.deck.y + 0.25 + j * 0.35;
    if (raycast(soup, H.lower.hw + 1.6, y, H.hatch.lz + 2.6, -1, 0, 0, 2.2)) hits++;
  }
  assert.equal(hits, 5, 'the flank forward of the hatch is not solid');
});

test('the aperture follows the boarding side', () => {
  /* The .glb is authored with the hole to starboard and mirrored by the loader
   * for a hull that boards to port — which is every berth in this yard. A
   * mirror that did not flip the winding would cull the whole hull; a mirror
   * that never happened would put the door on the wrong flank. */
  const port = build({ asset: true, side: -1 });
  const open = apertureBlocked(port, -1);
  assert.equal(open.blocked, 0, `${open.blocked} of ${open.total} rays through the port doorway were stopped`);
  const shut = apertureBlocked(port, 1);
  assert.ok(shut.blocked > shut.total * 0.8,
    `the starboard flank has a hole in it: only ${shut.blocked} of ${shut.total} rays were stopped`);
});

/* ================================================================== */
/* 6. The skin stays outside the rooms and inside the plan             */
/* ================================================================== */

test('no authored triangle intrudes into a compartment', () => {
  /* The compartment envelope is a contract in `HullPlan` and the skin is drawn
   * from tables of curves that have no idea the rooms are there. Inset by 0.02
   * so a surface landing exactly ON a room's face is not counted as through
   * it. The tightest case is the KEEL: the entry bay's sole is at 0.70 and the
   * skin's keel flat runs at 0.38 out to a half-width of 0.98, so 0.32 m of
   * clearance is all that separates a hull bottom from a room floor over eight
   * metres of this ship. The cannon are the other one — the gun bay is 0.80 m
   * to the centreline and the barrels are at 0.92 — and the generator draws
   * them at r 0.13 against the plan's 0.14 to keep the margin measurable. */
  let inside = 0;
  let worst = null;
  for (const [key, x, y, z] of authoredVerts()) {
    for (const r of H.rooms) {
      if (Math.abs(x) < r.hw - 0.02 && y > r.floorY + 0.02 && y < r.ceilY - 0.02
        && z > r.z0 + 0.02 && z < r.z1 - 0.02) {
        inside++;
        worst = `${key} at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) is inside '${r.id}'`;
      }
    }
  }
  assert.equal(inside, 0, worst ?? '');
});

test('the authored skin covers the span and the length the plan promises', () => {
  let minZ = Infinity, maxZ = -Infinity, maxX = 0, maxY = -Infinity, minY = Infinity;
  for (const [, x, y, z] of authoredVerts()) {
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    maxX = Math.max(maxX, Math.abs(x));
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(maxZ >= H.cannon.z1 - 0.01, `the guns stop at z ${maxZ}, the plan puts their muzzles at ${H.cannon.z1}`);
  assert.ok(minZ <= H.z0 - 0.5, `nothing reaches aft of the transom: aft-most is z ${minZ}`);
  assert.ok(Math.abs(maxX - H.wing.x1) < 0.01, `the span is ${maxX * 2}, the plan says ${H.wing.x1 * 2}`);
  assert.ok(maxY >= H.fin.y1 - 0.01, `the fin tops out at ${maxY}, the plan says ${H.fin.y1}`);
  /* Nothing below the cradle's bearing face, or the hull is drawn through the
   * saddles it stands on. The frame rings are the lowest thing on it, 0.025 m
   * proud of a keel that is itself 0.02 m over `SADDLE_TOP`. */
  assert.ok(minY >= PLAN.SADDLE_TOP - 0.03, `the skin reaches y ${minY}, the saddles bear at ${PLAN.SADDLE_TOP}`);
});

test('the chine is the widest line on the hull, which is the whole silhouette', () => {
  /* The Pike's read depends on ONE crease carrying the beam: a flank that bows
   * outboard of it turns the hull's defining edge into a dent, and it is not
   * visible in the tables — the tumblehome adds `bow*sin(pi*t)` while it only
   * takes away `(chw-dhw)*t`, so the bow wins near the chine unless it is
   * capped under 1/pi of the run. Two bakes put the widest point on the flank
   * before the cap went in: 2.375, then 2.356, against a 2.35 chine. */
  let best = -1, at = null;
  for (const [key, x, y, z] of authoredVerts()) {
    if (key !== 'hull') continue;
    if (Math.abs(x) > best) { best = Math.abs(x); at = [x, y, z]; }
  }
  assert.ok(Math.abs(best - H.lower.hw) < 0.005,
    `the widest point of the skin is ${best}, the plan's flank is ${H.lower.hw}`);
  assert.ok(at[1] > 1.80 && at[1] < 2.00,
    `the widest point is at y ${at[1]} — the chine runs 1.86..1.94, so that is on the flank, not on the crease`);
});

test('the authored wing is flat over the landing its first mantle finishes on', () => {
  /* `PIKE.bands[0]` mantles a body from the cradle top onto the wing at local
   * x 5.60, z 0, and `Climb` lands it 0.77 m inboard — so the drawn wing has
   * to be dead flat at `wing.y1` across x 4.4..5.6 or the player stands on a
   * collider with a sloped surface visibly under their feet. Every millimetre
   * of the aerofoil's taper is on the UNDERSIDE for exactly this reason. */
  const soup = assetSoup();
  const tops = [];
  /* Stations inside the TIP's own chord (z -0.55..0.95) and 5 cm inboard of
   * the tip edge, because a ray fired exactly along the outermost station of a
   * swept surface is a ray fired along its boundary. */
  for (let i = 0; i <= 6; i++) {
    for (const z of [-0.30, 0.10, 0.50]) {
      const x = 4.45 + i * 0.18;
      const hit = raycast(soup, x, H.wing.y1 + 0.9, z, 0, -1, 0, 1.2);
      assert.ok(hit, `nothing under the mantle landing at (${x}, ${z})`);
      tops.push(H.wing.y1 + 0.9 - hit.t);
    }
  }
  const lo = Math.min(...tops), hi = Math.max(...tops);
  assert.ok(hi - lo < 0.01, `the wing top varies by ${(hi - lo).toFixed(3)} m over the landing`);
  assert.ok(Math.abs(hi - H.wing.y1) < 0.01, `the wing top is ${hi}, the plan says ${H.wing.y1}`);
});

test('the wing root is buried in the plating and clear of the compartment', () => {
  /* A wing has to start INSIDE the skin to look attached to it, and the trunk
   * behind that skin is 1.20 m to the centreline — so there are two ways to
   * get this wrong and they are opposite. The generator roots the panel at
   * x 1.95 and this measures both margins on the baked mesh.
   *
   * The FUSELAGE alone is rayed, not the assembled hull: at wing height the
   * first surface outboard of the centreline in the built ship is the interior
   * trunk wall at x 1.15, which is a true fact about a different object. */
  /* The innermost wing vertex, found rather than assumed. Filtered by the
   * wing's own envelope: the fin, the cannon and the engines are `accent` too
   * and none of them is inside this box. */
  let root = Infinity;
  for (const [key, x, y, z] of authoredVerts()) {
    if (key !== 'accent') continue;
    if (y < 1.70 || y > 2.40 || z < -2.80 || z > 3.10) continue;
    root = Math.min(root, Math.abs(x));
  }
  assert.ok(root > H.rooms[1].hw + 0.5,
    'the wing reaches x ' + root.toFixed(2) + ', and the trunk behind it is ' + H.rooms[1].hw);
  const skin = assetSoup('hull');
  for (const z of [-2.4, -1.2, 0, 1.2, 2.4, 2.9]) {
    const hit = raycast(skin, 6, 2.34, z, -1, 0, 0, 5);
    assert.ok(hit, 'no flank at z ' + z);
    const x = 6 - hit.t;
    assert.ok(x > root + 0.03, 'at z ' + z + ' the skin at wing height is x ' + x.toFixed(2)
      + ' and the wing root is at ' + root.toFixed(2) + ' - the root is outside its own hull');
  }
});

/* ================================================================== */
/* 7. Degradation                                                      */
/* ================================================================== */

test('shipParts returns null when nothing is loaded, and the Pike still builds', () => {
  ASSETS.resetShipAssets();
  assert.equal(ASSETS.shipParts('pike'), null);
  const rec = build({ asset: false });
  assert.ok(triCount(rec.extRoot) > 9000);
});

test('a Pike whose file never arrives leaves the map without it', async () => {
  /* The loader's own failure path, driven with a fetch that 404s - which is
   * what a renamed file, a bad deploy or an offline CDN looks like from here.
   * It must resolve, not reject: a yard that throws because a hull mesh is
   * missing is worse than a yard with a boxy ship in it. */
  ASSETS.resetShipAssets();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).endsWith('manifest.json')
    ? { ok: true, json: async () => MANIFEST }
    : { ok: false, status: 404 });
  try {
    const map = await ASSETS.loadShipAssets();
    assert.equal(map['pike-hull'], undefined);
    assert.equal(ASSETS.shipParts('pike'), null);
  } finally {
    globalThis.fetch = realFetch;
    ASSETS.resetShipAssets();
  }
});

/* ================================================================== */
/* 8. The program budget                                               */
/* ================================================================== */

test('the authored Pike adds no material, and therefore no shader program', () => {
  /* `MazeAssets.firstGeometry` records the trap this repeats: a glTF material
   * is its own program family. The loader must hand back geometry and nothing
   * else, and every bucket the hull flushes must be a key the yard's own
   * material set already answers to. Measured on the built arms rather than
   * argued: the set of material instances used by the authored hull must be a
   * SUBSET of the procedural hull's, because a new instance with different
   * defines is a new compile. */
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
  for (const part of assetMap()['pike-hull']) {
    assert.equal(part.geometry.attributes.position.itemSize, 3);
    assert.ok(part.geometry.getAttribute('normal'), 'a part with no normals shades flat black');
    assert.ok(part.geometry.getAttribute('uv'), 'a part with no uvs samples the plating map at 0,0');
  }
});

test('no authored Pike vertex carries a non-finite number', () => {
  /* One NaN texture coordinate is not a few bad pixels: `UnrealBloomPass`
   * high-passes the frame and blurs the result through five mip levels, so the
   * additive composite writes NaN over every pixel on screen. The Kestrel did
   * exactly that on its first build in the browser and rendered a white screen
   * with a ship-shaped hole in it. The generator gates it; this pins the gate. */
  for (const p of assetMap()['pike-hull']) {
    for (const name of ['position', 'normal', 'uv']) {
      const a = p.geometry.getAttribute(name).array;
      for (let i = 0; i < a.length; i++) {
        assert.ok(Number.isFinite(a[i]), `${p.key}.${name}[${i}] is ${a[i]}`);
      }
    }
  }
});
