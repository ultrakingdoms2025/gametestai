import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { harness, triangles, raycast, PLAN } from './_hullrig.mjs';

/**
 * THE BASTION'S AUTHORED SKIN, AND BOTH ARMS OF THE HULL THAT IS NOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/tests/ship-assets.test.mjs` proved the pipeline on the Kestrel and
 * states the two failure modes an asset chain always has — the asset drifting
 * from the script that made it, and the fallback rotting because no headless
 * test ever runs the arm the player sees. Both apply here and neither is
 * covered there: that file is pinned to `kestrel-hull` by id.
 *
 * The Bastion adds a third question the Kestrel did not have to answer. She is
 * a WRECK, and what makes a wreck read is the structure you can see through
 * the holes: the frames in her stripped bays, the ribs of her open bow, the
 * ribs of the stern section standing on the shed floor. Every one of those is
 * an ANNULUS in section, and `sweep`'s end cap closes a section with a fan on
 * its own centroid — which for an annulus is in the hole. The first build of
 * this hull rasterised her stern section as a filled 11 x 6 m rectangle:
 * every frame was a plate, and the whole subject of the ship was painted in.
 * `basRib` exists because of that, and the test below fires rays between the
 * frames so it cannot come back.
 *
 * ── The invariant that matters most, again ──────────────────────────────────
 * The two arms must register the SAME structure. `ShipBuild.mute` suppresses
 * drawing and nothing else, so every collider, every `fill` and every aperture
 * is registered by the same code on both arms; the authored arm then adds
 * boxes for the three things it draws and the procedural arm does not. All of
 * them are named below, by half-extent, so a fourth cannot appear quietly.
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
const ENTRY = MANIFEST.assets.find((a) => a.id === 'bastion-hull');
const GLB = path.join(DIR, ENTRY.file);

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/** The cradle bearing height `DockWorld` builds her at, and the rig too. */
const CRADLE_TOP = 2.2;

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
  return { 'bastion-hull': parts };
}

function stubMaterials() {
  const M = {};
  for (const k of ['plate', 'steel', 'glass', 'emCyan', 'steelDark', 'grate',
    'hazard', 'crate', 'tarp', 'emAmber', 'emSodium', 'emRed', 'signs']) {
    M[k] = new THREE.MeshStandardMaterial({ name: k });
  }
  return M;
}

/** Build the Bastion with or without the authored skin. */
function build(o = {}) {
  ASSETS.resetShipAssets();
  ASSETS.installShipAssets(o.asset ? assetMap() : {});
  const physics = new Physics();
  const M = stubMaterials();
  const tint = { hull: 0x7a6f63, trim: 0x8a5a2b, glass: 0x2a3540, glow: 0xff4b45, accent: 0x5f6874 };
  const { mats } = shipMaterials(M, tint);
  const ext = new GeoBatch();
  const int = new GeoBatch();
  const group = new THREE.Group();
  const b = new ShipBuild({
    batch: ext, interior: int, physics, track: (c) => c, group,
    x: 0, y: 0, z: 0, yaw: 0,
  });
  const result = HULLS_SRC.buildBastion(b, CRADLE_TOP, mats);
  const extRoot = new THREE.Group();
  const intRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'arm', {});
  int.flush(intRoot, mats, 'arm-in', {});
  extRoot.updateMatrixWorld(true);
  intRoot.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  ASSETS.resetShipAssets();
  return { b, extRoot, intRoot, group, physics, result, mats };
}

const withAsset = build({ asset: true });
const noAsset = build({ asset: false });

const triCountOf = (...roots) => {
  let n = 0;
  for (const r of roots) {
    r.traverse((m) => {
      if (!m.isMesh) return;
      const idx = m.geometry.getIndex();
      n += (idx ? idx.count : m.geometry.attributes.position.count) / 3;
    });
  }
  return n;
};

const B = PLAN.BASTION;

/* ================================================================== */
/* 1. The manifest, and the file it declares                           */
/* ================================================================== */

test('the manifest declares the file that is actually on disk', () => {
  assert.ok(existsSync(GLB), `${GLB} is missing`);
  assert.equal(ENTRY.kind, 'geometry');
  assert.equal(ENTRY.hull, 'bastion');
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
    /* A key the yard has no material for flushes with `undefined`, and three.js
     * draws that white with a program of its own - the one cost this whole
     * pipeline exists to avoid. */
    assert.ok(withAsset.mats[n], `no yard material for key '${n}'`);
  }
});

test('the Bastion is registered in the hull registry the loader reads', () => {
  assert.equal(ASSETS.SHIP_ASSET_HULLS.bastion, 'bastion-hull',
    'SHIP_ASSET_HULLS must map the hull id to the asset id or shipParts never returns');
});

/* ================================================================== */
/* 2. The generator is the file's only author                          */
/* ================================================================== */

test('re-running the generator reproduces the committed file byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bastion-glb-'));
  try {
    const out = path.join(dir, 'bastion-hull.glb');
    execFileSync(process.execPath, ['scripts/make-ship-glb.mjs'], {
      cwd: ROOT,
      env: { ...process.env, SHIP_GLB_OUT: out, SHIP_GLB_HULL: 'bastion' },
      stdio: 'pipe',
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
  const P = gen.BASTION_PLAN;
  assert.equal(P.z0, B.lower.z0); assert.equal(P.z1, B.lower.z1);
  assert.equal(P.lowerHW, B.lower.hw);
  assert.equal(P.deckY, B.ledge.y - 0.16, 'the skin stops on the ledge slab underside');
  assert.equal(P.upperY0, B.upper.y0);
  assert.equal(P.upperHW, B.upper.hw);
  assert.equal(P.upperY1, B.spine.y - 0.16, 'the upper closes under the spine slab');
  assert.deepEqual(P.bays.map((c) => [c.z0, c.z1, c.y0, c.y1]),
    B.stripped.map((c) => [c.z0, c.z1, c.y0, c.y1]));
  assert.equal(P.stern.z0, B.sternRibs.z0); assert.equal(P.stern.z1, B.sternRibs.z1);
  assert.equal(P.stern.hw, B.sternRibs.hw);
  assert.equal(P.stern.y0, B.sternRibs.y0); assert.equal(P.stern.y1, B.sternRibs.y1);
  assert.equal(P.bell.lx, B.bell.lx); assert.equal(P.bell.lz, B.bell.lz);
  assert.equal(P.bell.y0, B.bell.y0); assert.equal(P.bell.rMouth, B.bell.r1);
  assert.equal(P.tower.z0, B.tower.z0); assert.equal(P.tower.z1, B.tower.z1);
  assert.equal(P.tower.hw, B.tower.hw);
  assert.equal(P.tower.y0, B.tower.y0); assert.equal(P.tower.y1, B.tower.y1);
});

/* ================================================================== */
/* 3. Both arms build, and only one of them draws boxes                */
/* ================================================================== */

test('the authored arm draws the asset and the procedural arm does not', () => {
  /* Exact counts, and they are this drop's own headline numbers:
   *
   *   procedural   32,024 exterior triangles   (no interior: she is a hulk)
   *   authored     17,918 exterior triangles
   *
   * of which 14,582 are the .glb itself; the rest is the two walkable plates,
   * the barbettes, the barrel, the mast, the berth stencils, the tarp and the
   * deck fittings that both arms draw. The authored hull is 44% LIGHTER than
   * the box hull it replaces, and that is the justification for the budget:
   * `relief` (x 162 + a run per bay), `panelLines`, three `course` runs with
   * their bolt rows, twelve `rib`s, four `knuckle` strakes and 62 stanchion
   * boxes across the bow and stern all come off, and one swept skin with
   * curved ribs costs less than the boxes that were pretending to be them.
   *
   * Pinned rather than bounded on purpose. The fallback is not a degraded mode
   * - it is the hull `dock-hulls`, `dock-reach` and `dock-hull-shape` all
   * measure - so a change to it should be a decision somebody made rather than
   * a number that drifted. */
  assert.equal(triCountOf(noAsset.extRoot, noAsset.group), 32024,
    'the procedural hull changed shape');
  assert.equal(triCountOf(withAsset.extRoot, withAsset.group), 17918,
    'the authored hull changed shape');
  assert.ok(triCountOf(withAsset.extRoot, withAsset.group) < 38000,
    'the Bastion is the hull nearest the 38,000 exterior ceiling and must stay under it');
});

test('she still has no interior, and no rooms, on either arm', () => {
  /* A doorless `enterables` descriptor and nothing behind it - see
   * `HullPlan.BASTION`. If the authored arm ever grew a room the collectible
   * streaming path would start looking for a floor she does not have. */
  assert.deepEqual(withAsset.result.rooms, []);
  assert.deepEqual(noAsset.result.rooms, []);
  assert.equal(triCountOf(withAsset.intRoot), 0);
  assert.equal(triCountOf(noAsset.intRoot), 0);
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
  const P = noAsset.physics.colliders.filter((c) => c.type === 'box').map(spec).sort();
  const onlyA = A.filter((s) => !P.includes(s));
  const onlyP = P.filter((s) => !A.includes(s));

  /* Everything that carries the ship - the plating runs, the two `fill`
   * volumes, the ledge and spine plates, the tower loft, the barbettes, the
   * open bow's stanchions, the stern section's posts - is registered by the
   * SAME code on both arms, because `mute` suppresses drawing and nothing
   * else. There are exactly three deliberate additions on the authored arm and
   * they are all named here, by half-extent.
   *
   *   12 x <w>,3.05,0.24    the stern section's ribs, two per frame, each cut
   *                         to its OWN leg's plan: the half-width grows aft to
   *                         forward with the section, 0.7555 to 1.018. The
   *                         plan collides one 0.4 m post per frame at +/-7.6
   *                         and an authored rib is a curved leg 2.5 m inboard
   *                         of it at the after end. This is the one part of
   *                         her a player walks THROUGH.
   *    4 x 0.42,0.42,~2.97  the peeled plates, which reach 0.70 m outboard of
   *                         the flank and 0.14 m over the ledge deck
   *    4 x 0.25,0.64,0.2    the bell stand's cradle bearers, legs only
   *    1 x 2.05,0.225,2.4   the bell stand's plinth
   *
   * NOTHING is procedural-only, and that is the load-bearing half: it means
   * the authored arm is a strict superset, so no collider the climb, the reach
   * flood or the walk probes rely on has gone missing. */
  const halves = (s) => s.split(',').slice(3).join(',');
  const BEARER = '0.25,0.64,0.2', PLINTH = '2.05,0.225,2.4';
  const RIBS = ['0.7555', '0.874', '0.9515', '0.9932', '1.0112', '1.018']
    .flatMap((w) => [`${w},3.05,0.24`, `${w},3.05,0.24`]);
  const expect = [
    ...RIBS, ...Array(4).fill(BEARER), PLINTH,
    '0.42,0.42,2.904', '0.42,0.42,2.904', '0.42,0.42,3.036', '0.42,0.42,3.036',
  ].sort();
  assert.deepEqual(onlyA.map(halves).sort(), expect,
    `unexpected authored-only colliders:\n${onlyA.join('\n')}`);
  assert.deepEqual(onlyP, [], `the authored arm dropped a collider:\n${onlyP.join('\n')}`);
  assert.equal(A.length - onlyA.length, 164, 'the shared structure changed size');
});

test('the climb bands still grip the faces the plan names, on the authored skin', () => {
  /* `BASTION.bands` grip local x 8.00 and x 6.20 at z -6.0, and the whole
   * flank taper in the generator is arranged around holding exactly those two
   * faces over the parallel middle body. A ray fired inboard along the band's
   * own station has to stop ON the face, not 20 cm inside it. */
  const soup = triangles([withAsset.extRoot, withAsset.group]);
  for (const band of B.bands) {
    const y = (band.from + band.to) / 2;
    const hit = raycast(soup, 14, y, band.z, -1, 0, 0, 14);
    assert.ok(hit, `nothing at all on the climb face at y ${y}, z ${band.z}`);
    const x = 14 - hit.t;
    assert.ok(Math.abs(x - band.faceX) < 0.06,
      `the band that grips x ${band.faceX} meets the authored skin at x ${x.toFixed(3)}`);
  }
});

test('the stripped bays are holes in the authored skin, and they have depth', () => {
  /* The measurement the whole silhouette depends on. A ray fired inboard at a
   * bay must run 0.6 m past the plating line before it meets anything; a ray
   * fired at a plated station must stop on the plating.
   *
   * Measured: bays stop at x 7.38 against a flank at 8.00 - so the bay is
   * 0.62 m deep, which is the inner skin, and nothing (relief, a course, a
   * panel) has been painted back into it. */
  const soup = triangles([withAsset.extRoot, withAsset.group]);
  /* Fired from 8.5 and not from 14, and the difference is the engine bell:
   * she stands at local x -11.5 with a 3.2 m mouth over z -16.2..-9.8, which
   * is squarely across the port approach to the after bay. A probe launched
   * from outside her measured that bay as 0.6 m deep in the wrong direction. */
  const START = 8.5;
  for (const c of B.stripped) {
    const z = (c.z0 + c.z1) / 2;
    for (const y of [c.y0 + 0.35, (c.y0 + c.y1) / 2, c.y1 - 0.35]) {
      for (const s of [-1, 1]) {
        const hit = raycast(soup, s * START, y, z, -s, 0, 0, START);
        assert.ok(hit, `the bay at z ${z} has nothing behind it at all`);
        const x = START - hit.t;
        assert.ok(x < 7.55,
          `the bay at z ${z}, y ${y} stops at x ${x.toFixed(2)} - it has been filled back in`);
      }
    }
  }
  // And the plating between the bays is still plating.
  for (const z of [-6.0, -3.0]) {
    for (const s of [-1, 1]) {
      const hit = raycast(soup, s * START, 2.3, z, -s, 0, 0, START);
      const x = START - (hit?.t ?? START);
      assert.ok(x > 7.9, `the flank at z ${z} stops at x ${x.toFixed(2)} - the skin has a hole in it`);
    }
  }
});

test('the open bow is FRAMES, and there is daylight between them', () => {
  /* The failure this replaces was silent and total: built as a `sweep` with
   * `capFore`, every rib closed with a fan on its own centroid - which for an
   * annulus is the hole - so each frame rendered as a solid plate and the
   * three-quarter silhouette came back as a filled rectangle. A wreck whose
   * frames are plates is a box with a box-shaped hole in it.
   *
   * So: fire a fan of rays ACROSS the open bow, station by station, and count
   * how many get right through. y 2.9 is chosen to run between the stringers -
   * the chine's is at 2.5 and the next one up at 3.2 - so what stops a ray
   * there is a frame and only a frame. Seven frames at 1.53 m centres, 0.34 m
   * thick, must let most of them past. */
  const soup = triangles([withAsset.extRoot, withAsset.group]);
  const OB = B.openBow;
  let through = 0, total = 0;
  for (let i = 0; i < 24; i++) {
    const z = OB.z0 + 0.6 + ((OB.z1 - OB.z0 - 1.2) * i) / 23;
    total++;
    if (!raycast(soup, 12, 2.9, z, -1, 0, 0, 24)) through++;
  }
  assert.ok(through >= 12,
    `only ${through} of ${total} rays got through the open bow - the frames are plates, not ribs`);
});

test('the stern section is ribs a body can walk between, and they are collided', () => {
  const soup = triangles([withAsset.extRoot, withAsset.group]);
  const S = B.sternRibs;
  let through = 0, total = 0;
  for (let i = 0; i < 24; i++) {
    const z = S.z0 + 0.6 + ((S.z1 - S.z0 - 1.2) * i) / 23;
    total++;
    /* Across the section at chest height on a body standing on the shed floor
     * - local y -2.2 IS the floor - and at -0.45 rather than -1.30, which runs
     * between the two lowest stringers (-1.22 and 0.36) instead of straight
     * down the length of the lower one. */
    if (!raycast(soup, 12, -0.45, z, -1, 0, 0, 24)) through++;
  }
  assert.ok(through >= 12,
    `only ${through} of ${total} rays crossed the stern section - it is a wall, not a set of ribs`);

  /* And every leg the authored arm draws is collided, or it is a rib a player
   * walks through. Fired at the leg's own line, the ray must stop, and a box
   * must contain the point it stopped at. */
  const boxes = withAsset.physics.colliders.filter((c) => c.type === 'box');
  const inBox = (x, y, z) => boxes.some((c) => {
    const e = c.matrix.elements;
    return Math.abs(x - e[12]) <= c.halfExtents.x + 0.02
      && Math.abs(y - e[13]) <= c.halfExtents.y + 0.02
      && Math.abs(z - e[14]) <= c.halfExtents.z + 0.02;
  });
  for (let i = 0; i <= S.frames; i++) {
    const z = S.z0 + ((S.z1 - S.z0) * i) / S.frames;
    const hit = raycast(soup, 14, 0.6, z, -1, 0, 0, 14);
    assert.ok(hit, `no rib at the stern frame on z ${z}`);
    const x = 14 - hit.t;
    assert.ok(inBox(x + 0.05, 0.6, z),
      `the stern rib at z ${z} is drawn at x ${x.toFixed(2)} with no collider on it`);
  }
});

test('the authored hull adds no material, and therefore no shader program', () => {
  /* The performance contract, and the reason every mesh in the .glb is named
   * for a material key: a loaded glTF material is its own program family. The
   * authored arm's material set must be a SUBSET of the procedural arm's. */
  const set = (root) => {
    const s = new Set();
    root.traverse((o) => { if (o.isMesh) s.add(o.material?.name ?? '(none)'); });
    return s;
  };
  const A = set(withAsset.extRoot), P = set(noAsset.extRoot);
  for (const m of A) assert.ok(P.has(m), `the authored arm introduced material '${m}'`);
});

test('no authored vertex carries a non-finite number', () => {
  /* 148 NaN uvs from a patch that wrapped past its own arc-length table
   * rendered the Kestrel as a white screen with a ship-shaped hole - one NaN
   * texel smeared through the whole bloom pyramid. The generator gates it at
   * build time; this gates the committed file. */
  parsed.scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const name of ['position', 'normal', 'uv']) {
      const a = o.geometry.getAttribute(name);
      assert.ok(a, `mesh '${o.name}' has no ${name}`);
      for (let i = 0; i < a.array.length; i++) {
        assert.ok(Number.isFinite(a.array[i]),
          `mesh '${o.name}' has a non-finite ${name} at ${i}`);
      }
    }
  });
});

test('the authored skin covers the beam and the length the plan promises', () => {
  const box = new THREE.Box3().setFromObject(withAsset.extRoot);
  /* The whole assembly: the plated body, the open bow out to z 22, the stern
   * section back to z -35.5 and the bell out to port. */
  assert.ok(box.min.z <= B.sternRibs.z0 - 0.4,
    `the stern section stops at z ${box.min.z.toFixed(1)}, short of ${B.sternRibs.z0}`);
  assert.ok(box.max.z >= B.openBow.z1 - 0.5,
    `the bow stops at z ${box.max.z.toFixed(1)}, short of ${B.openBow.z1}`);
  assert.ok(box.max.y >= B.tower.y1 - 0.05,
    `the tower crowns at y ${box.max.y.toFixed(2)}, short of ${B.tower.y1}`);
  assert.ok(box.min.x <= B.bell.lx - B.bell.r1 + 0.1,
    `the bell reaches x ${box.min.x.toFixed(1)}, short of ${(B.bell.lx - B.bell.r1).toFixed(1)}`);
});

test('shipParts returns null when nothing is loaded, and the hull still builds', () => {
  ASSETS.resetShipAssets();
  assert.equal(ASSETS.shipParts('bastion'), null);
  const again = build({ asset: false });
  assert.ok(triCountOf(again.extRoot, again.group) > 0, 'the fallback hull built nothing');
});
