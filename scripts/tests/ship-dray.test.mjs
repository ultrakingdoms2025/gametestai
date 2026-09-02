import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { harness, triangles, raycast, PLAN, CRADLE_TOP } from './_hullrig.mjs';

/**
 * THE DRAY'S AUTHORED SKIN, AND BOTH ARMS OF THE HULL THAT IS NOT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS FILE IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `scripts/make-ship-glb.mjs` with `SHIP_GLB_HULL=dray` writes
 * `public/assets/ship/dray-hull.glb`, `src/ships/ShipAssets.js` loads it and
 * `Hulls.buildDray` draws it instead of the plated drum. That is the same two
 * failure modes `ship-assets.test.mjs` names for the Kestrel, so this file is
 * aimed at both of them for this hull:
 *
 * 1. **The asset drifts from the script that made it.** A .glb is a binary
 *    blob and a diff will not tell you it was hand-edited or re-exported from
 *    somewhere else. So the generator is RE-RUN here, into a temp directory,
 *    and the bytes are compared.
 * 2. **The fallback rots.** `shipParts` returns null under `node --test` — no
 *    `fetch`, no manifest — so `dock-hulls`, `dock-reach`, `dock-interiors`
 *    and `dock-hull-shape` all measure the PROCEDURAL Dray and would stay
 *    green if the authored arm never drew anything at all. The real committed
 *    .glb is therefore parsed off disk, installed into the loader's cache and
 *    built through the real `buildDray`.
 *
 * ── The invariant that matters most ─────────────────────────────────────────
 * The two arms must register the SAME SHIP. `ShipBuild.mute` suppresses the
 * drawing and nothing else, so every collider, aperture, room, door and light
 * is built by the same code on both arms; the only differences allowed are
 * named below, by half-extent, so that a fifth one cannot appear quietly.
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
const ENTRY = MANIFEST.assets.find((a) => a.id === 'dray-hull');
const GLB = path.join(DIR, ENTRY.file);
const H = PLAN.DRAY;

/** Licences an asset in this repository may carry. Same list as the maze's. */
const LICENCES = ['generated', 'CC0-1.0', 'CC-BY-4.0', 'proprietary-owned'];

/** The committed .glb, parsed the way the game parses it. */
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
  return { 'dray-hull': parts };
}

function stubMaterials() {
  const M = {};
  for (const k of ['plate', 'steel', 'glass', 'emCyan', 'steelDark', 'grate',
    'hazard', 'crate', 'tarp', 'emAmber', 'emSodium', 'emRed', 'signs']) {
    M[k] = new THREE.MeshStandardMaterial({ name: k });
  }
  return M;
}

/** Build the Dray with or without the authored skin. */
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
  const result = HULLS_SRC.buildDray(b, o.side ?? 1, CRADLE_TOP.dray, mats);
  const extRoot = new THREE.Group();
  const intRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'arm', {});
  int.flush(intRoot, mats, 'arm-in', {});
  extRoot.updateMatrixWorld(true);
  intRoot.updateMatrixWorld(true);
  group.updateMatrixWorld(true);
  ASSETS.resetShipAssets();
  return { b, ext, int, extRoot, intRoot, group, physics, result, mats };
}

/**
 * A soup of just the named authored meshes.
 *
 * The dressing stands 0.02-0.04 m proud of the skin — it is generated from the
 * same section functions, which is the whole point of it — so a probe fired at
 * "the flank" hits the knuckle strake and reads 5.224 against a plan that says
 * 5.20. Where the question is about the SKIN, ask the skin.
 */
function partSoup(keys) {
  const g = new THREE.Group();
  for (const p of assetMap()['dray-hull']) {
    if (keys.includes(p.key)) g.add(new THREE.Mesh(p.geometry, new THREE.MeshBasicMaterial()));
  }
  g.updateMatrixWorld(true);
  return triangles([g]);
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
  assert.equal(ENTRY.hull, 'dray');
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
  /* And every key must be one this hull's material set answers to, or the
   * bucket flushes with `undefined`: a mesh drawn in three.js's default white
   * WITH A PROGRAM OF ITS OWN, which is the one cost this pipeline exists to
   * avoid. */
  for (const n of names) assert.ok(withAsset.mats[n], `no yard material for key '${n}'`);
});

test('the hull registry claims this asset', () => {
  assert.equal(ASSETS.SHIP_ASSET_HULLS.dray, 'dray-hull');
});

/* ================================================================== */
/* 2. The generator is the file's only author                          */
/* ================================================================== */

test('re-running the generator reproduces the committed file byte for byte', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dray-glb-'));
  try {
    const out = path.join(dir, 'dray-hull.glb');
    execFileSync(process.execPath, ['scripts/make-ship-glb.mjs'], {
      cwd: ROOT,
      env: { ...process.env, SHIP_GLB_HULL: 'dray', SHIP_GLB_OUT: out },
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
  const P = gen.DRAY;
  assert.equal(P.z0, H.z0); assert.equal(P.z1, H.z1);
  assert.equal(P.bellyY0, H.belly.y0);
  assert.equal(P.bellyY1, H.belly.y1);
  assert.equal(P.bellyHW, H.belly.hw);
  assert.equal(P.lowerHW, H.lower.hw);
  assert.equal(P.lowerY0, H.lower.y0);
  assert.equal(P.ledgeY, H.ledge.y);
  assert.equal(P.ledgeOuter, H.ledge.outer);
  assert.equal(P.spineY, H.spine.y);
  assert.equal(P.spineHW, H.spine.hw);
  assert.deepEqual(P.upper, { ...H.upper });
  assert.deepEqual(P.bridge, { ...H.bridge });
  assert.equal(P.deckY, H.deck.y);
  assert.equal(P.roomHW, H.rooms[0].hw);
  assert.equal(P.holdCeilY, H.rooms[0].ceilY);
  assert.equal(P.hatch.lz, H.hatch.lz);
  assert.equal(P.hatch.w, H.hatch.w);
  assert.equal(P.hatch.h, H.hatch.h);
  assert.deepEqual(P.spineHole, { ...H.spineHole });
});

/* ================================================================== */
/* 3. Both arms build, and only one of them draws boxes                */
/* ================================================================== */

test('the authored arm draws the asset and the procedural arm does not', () => {
  /* Exact counts, and they are this deliverable's headline numbers:
   *
   *   procedural   22,900 exterior triangles   (+4,208 interior, both arms)
   *   authored     13,257 exterior triangles   (+4,208 interior, both arms)
   *
   * of which 7,779 are the .glb itself; the rest is the two weather decks, the
   * foredeck furniture, the derrick, the hoppers, the radiator, the gear, the
   * cargo door and the bridge roof, all of which both arms draw. The authored
   * hull is LIGHTER than the box hull it replaces by 9,643 triangles, which is
   * the answer to "state your triangle count against the current one and
   * justify it": the budget went DOWN, and the triangles that remain are
   * describing curvature instead of standing plates on edge. 222 `relief`
   * props and two grids of panel lines cost more than a whole swept skin.
   *
   * Pinned rather than bounded on purpose. The fallback is not a degraded
   * mode — it is the hull `dock-hulls`, `dock-reach`, `dock-interiors` and
   * `dock-hull-shape` all measure — so a change to it should be a decision
   * somebody made, not a number that drifted.
   *
   * ── Re-taken 2026-09-02: the kit learned to chamfer ──────────────────
   * Procedural exterior 22,612 -> 22,900, +288. Authored exterior UNCHANGED at
   * 13,257, and that asymmetry is the proof of what moved: `boxGeo` now
   * chamfers a box whose smallest dimension reaches the kit's 1.0 m, and the
   * only three boxes on this hull that qualify are the engine-bell mounts on
   * the transom — 1.9 x 1.9 x 1.2, at lx -3/0/+3, drawn by `cbox` inside the
   * `mute(true)` region. The authored arm does not draw that region (the
   * bells are part of the one baked surface), so it cannot move. Three boxes
   * x 96 triangles a chamfered box costs over a plain one = 288, exactly.
   *
   * They are the case the kit default is FOR and not the case it warns about:
   * chunky masses standing proud of the transom with a 1.1 m gap between
   * neighbours, so there is no butted run to grow a ladder of dark seams. The
   * mounts are drawn through `cbox`, which collides the FULL box, so the
   * chamfer only ever cuts geometry away from inside the collider — and
   * `both arms register the same STRUCTURE` below is unchanged, which is the
   * measurement that says so.
   *
   * The interior figure moved with the same commit and for a different rule:
   * `ShipKit.ibox` chamfers from 12 cm, which catches 35 of this hull's
   * fittings for +3,360, taking 848 -> 4,208. It is stated per arm rather
   * than pinned because the assertion below compares the two arms to each
   * other — `mute` suppresses exterior drawing only, so both arms fit out the
   * same compartments and both grew by the same 3,360. */
  assert.equal(triCountOf(noAsset.extRoot) + triCountOf(noAsset.group), 22900,
    'the procedural hull changed shape');
  assert.equal(triCountOf(withAsset.extRoot) + triCountOf(withAsset.group), 13257,
    'the authored hull changed shape');
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

  /* Everything that carries the ship — the plating, both weather decks, the
   * side tanks, the bulkheads, the lofts, the bridge castle, the gear, the
   * hoppers, the radiator — is registered by the SAME code on both arms,
   * because `mute` suppresses drawing and nothing else. There are exactly two
   * kinds of deliberate exception:
   *
   *   authored only   one box per external tank (0.64 x 0.64 x 2.70),
   *                   inscribed in the 0.90 m shell
   *   procedural only the tie-down rings in `relief` (0.05 x 0.11 x 0.11) —
   *                   the one relief prop that is collided, and dressing the
   *                   authored arm does not draw, so it does not collide it
   */
  const halves = (s) => s.split(',').slice(3).join(',');
  const TANK = '0.64,0.64,2.7', RING = '0.05,0.11,0.11';
  assert.deepEqual(onlyA.map(halves).sort(), [TANK, TANK],
    `unexpected authored-only colliders:\n${onlyA.join('\n')}`);
  assert.ok(onlyB.length > 0, 'the procedural relief stopped colliding anything');
  assert.deepEqual([...new Set(onlyB.map(halves))], [RING],
    `unexpected procedural-only colliders:\n${onlyB.join('\n')}`);
  /* And the shared set is the whole of the structure. */
  assert.equal(A.length - onlyA.length, 102);
});

test('both arms publish the same rooms, doors, lift and boarding point', () => {
  assert.deepEqual(withAsset.result.rooms, noAsset.result.rooms);
  assert.equal(withAsset.b.doors.length, noAsset.b.doors.length);
  assert.deepEqual(withAsset.b.apertures, noAsset.b.apertures);
  assert.equal(withAsset.result.door.id, noAsset.result.door.id);
  assert.equal(withAsset.result.engineDoor.id, noAsset.result.engineDoor.id);
  assert.ok(withAsset.result.lift, 'the cargo lift is gone from the authored arm');
  assert.equal(withAsset.result.lights.length, noAsset.result.lights.length);
});

test('the authored arm still records where its three engines exhaust', () => {
  /* `ShipModel` hangs the flown hull's plume off `nozzles`, and `bell()` is
   * what records them — it is muted, not skipped, so the record survives. A
   * hull with none burns nothing under throttle and nobody notices in a
   * screenshot. */
  assert.equal(withAsset.b.nozzles.length, 3);
  assert.deepEqual(withAsset.b.nozzles, noAsset.b.nozzles);
  for (const nz of withAsset.b.nozzles) {
    assert.ok(nz.r > 0.2, 'a plume needs a radius');
    /* And the authored casing has to END where that plume starts, or the fire
     * comes out of the air behind the ship. Measured off the baked mesh. */
    assert.ok(nz.lz > -15.75 && nz.lz < -15.5,
      `the plume starts at z ${nz.lz}, the authored casing ends at -15.55`);
  }
});

/* ================================================================== */
/* 5. The cargo door is a hole in the authored skin too                */
/* ================================================================== */

/**
 * Fire a fan of rays from outside the flank into the hold, through the cargo
 * aperture, and count what gets through.
 *
 * `dock-hull-shape` does this to the procedural hull and its header records
 * what it found the first time: 73 of 81 samples blocked, by relief patches
 * and courses laid over the doorway. An authored skin is one surface with a
 * hole cut in it, so the question is whether the hole is where the plan says
 * the door is — a hole in the wrong place passes every geometry test ever
 * written and traps the player outside their own ship.
 */
function apertureBlocked(rec, side) {
  /* `rec.group` is deliberately absent: the loose door LEAVES live there and
   * they are shut at build time, so a soup that includes them measures a
   * closed door rather than a doorway. `ship-assets.test.mjs` probes the
   * Kestrel the same way and for the same reason. */
  const soup = triangles([rec.extRoot, rec.intRoot]);
  const x0 = side * (H.lower.hw + 1.8);
  let blocked = 0, total = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const z = H.hatch.lz + (i / 8 - 0.5) * (H.hatch.w - 0.30);
      const y = H.deck.y + 0.14 + (j / 8) * (H.hatch.h - 0.34);
      if (raycast(soup, x0, y, z, -side, 0, 0, 1.8 + 0.9)) blocked++;
      total++;
    }
  }
  return { blocked, total };
}

test('the cargo aperture is a hole in the authored skin', () => {
  const r = apertureBlocked(withAsset, 1);
  assert.equal(r.blocked, 0, `${r.blocked} of ${r.total} rays through the doorway were stopped`);
});

test('the skin is solid where the doorway is not', () => {
  /* The complement, and it is the assertion that makes the one above mean
   * anything: a skin with no flank at all would pass an aperture probe
   * perfectly. Fired at the same heights, 4 m forward and 4 m aft of the
   * hatch. */
  const soup = triangles([withAsset.extRoot]);
  let hits = 0, total = 0;
  for (const dz of [-4.0, 4.0]) {
    for (let j = 0; j < 5; j++) {
      const y = H.deck.y + 0.4 + j * 0.55;
      total++;
      if (raycast(soup, H.lower.hw + 1.8, y, H.hatch.lz + dz, -1, 0, 0, 2.6)) hits++;
    }
  }
  assert.equal(hits, total, `only ${hits} of ${total} rays met plating either side of the hatch`);
});

test('the aperture follows the boarding side', () => {
  /* The .glb is authored with the hole to starboard and mirrored by the loader
   * for a hull that boards to port — which this one does (`boardSide` returns
   * -1 for her berth). A mirror that did not flip the winding would cull the
   * whole hull; a mirror that never happened would put a 3 m cargo door on the
   * wrong flank and leave the ramp running out at a wall. */
  const port = build({ asset: true, side: -1 });
  const open = apertureBlocked(port, -1);
  assert.equal(open.blocked, 0, `${open.blocked} of ${open.total} rays through the port doorway were stopped`);
  const shut = apertureBlocked(port, 1);
  assert.ok(shut.blocked > shut.total * 0.8,
    `the starboard flank has a hole in it: only ${shut.blocked} of ${shut.total} rays were stopped`);
});

/* ================================================================== */
/* 6. The skin stays outside the rooms and outside the walked decks     */
/* ================================================================== */

test('no authored triangle intrudes into a compartment', () => {
  /* The three compartments are contracts in `HullPlan` and this skin is drawn
   * from a table of curves that has no idea they are there. Inset by 0.02 so a
   * surface that lands exactly ON a room's face is not counted as through it. */
  const parts = assetMap()['dray-hull'];
  let inside = 0;
  const worst = [];
  const v = new THREE.Vector3();
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      for (const r of H.rooms) {
        if (Math.abs(v.x) < r.hw - 0.02 && v.y > r.floorY + 0.02 && v.y < r.ceilY - 0.02
          && v.z > r.z0 + 0.02 && v.z < r.z1 - 0.02) {
          inside++;
          if (worst.length < 6) worst.push(`${p.key} (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}) in ${r.id}`);
        }
      }
    }
  }
  assert.equal(inside, 0, `${inside} authored vertices are inside a compartment:\n  ${worst.join('\n  ')}`);
});

test('the authored skin clears every route published over the two decks', () => {
  /* Rule 4: nothing drawn may stand in the air over a surface a body walks.
   * The Dray publishes three such surfaces and this asserts all three, by
   * their own numbers rather than by a margin invented here:
   *
   *   the side decks   1.15 m each flank outboard of the deckhouse, walked
   *                    from end to end. 2.00 m of clear air over 4.56,
   *                    for anything standing more than 0.25 m proud of the
   *                    deckhouse wall — the procedural hull runs a string
   *                    course 0.16 m proud of that same wall over that same
   *                    deck, so the rule is about what OVERHANGS a walkway
   *                    rather than about a wall having trim on it.
   *   the spine lane   `DRAY.hoppers` states it: "`lane` is the half-width
   *                    kept clear down the centre of the spine, and it is 1.2".
   *   the mantle       `bands[1]` grips x 4.05 at z 0.5 and `Climb` lands the
   *                    body 0.77 m inboard of the face it gripped, where it
   *                    demands MANTLE_HEADROOM = 1.55 m of clear air.
   *
   * The two external tanks and their saddles are the only authored geometry
   * anywhere near any of them, and this is what holds them where they are. */
  const parts = assetMap()['dray-hull'];
  const bad = [];
  const v = new THREE.Vector3();
  const landX = H.bands[1].faceX - 0.77;
  for (const p of parts) {
    const pos = p.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const ax = Math.abs(v.x);
      if (v.z > H.lower.z0 && v.z < H.lower.z1
        && ax > H.upper.hw + 0.25 && ax < H.ledge.outer
        && v.y > H.ledge.y + 0.03 && v.y < H.ledge.y + 2.00) {
        bad.push(`side deck: ${p.key} (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
      }
      if (v.z > H.spine.z0 && v.z < H.spine.z1 && ax < 1.20
        && v.y > H.spine.y + 0.03 && v.y < H.spine.y + 2.00
        && !(v.z > H.bridge.z0 - 0.2 && v.z < H.bridge.z1 + 0.2)) {
        bad.push(`spine lane: ${p.key} (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
      }
      if (Math.hypot(ax - landX, v.z - H.bands[1].z) < 0.70
        && v.y > H.spine.y + 0.03 && v.y < H.spine.y + 1.55) {
        bad.push(`mantle: ${p.key} (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`);
      }
    }
  }
  assert.deepEqual(bad.slice(0, 8), [], `${bad.length} authored vertices stand over a published route`);
});

test('the flank the climb grips is where the collider says it is', () => {
  /* Band 0 grips local x 5.20 at z -8.0 from the cradle top up to the ledge,
   * and `plated` collides that flank as a box 0.84..4.56 at exactly 5.20. The
   * skin is allowed to tuck INSIDE that box — 0.09 m of tumblehome at the deck
   * edge, and the hopper slope below the knuckle — but the face the hand goes
   * on has to be the face that is drawn. Measured over the run the band uses. */
  const soup = partSoup(['hull']);
  const z = H.bands[0].z;
  for (let j = 0; j <= 6; j++) {
    const y = 2.20 + j * 0.30;                 // the knuckle up to the deck edge
    const hit = raycast(soup, H.bands[0].standX + 1.5, y, z, -1, 0, 0, 3.5);
    assert.ok(hit, `nothing drawn at the grip face at y ${y.toFixed(2)}`);
    const x = H.bands[0].standX + 1.5 - hit.t;
    assert.ok(x > H.lower.hw - 0.12 && x <= H.lower.hw + 0.001,
      `the skin at y ${y.toFixed(2)} is at x ${x.toFixed(3)}, against a collider at ${H.lower.hw}`);
  }
});

test('the hopper knuckle carries the max beam, and the section is not a rectangle', () => {
  /* The shape claim, as a measurement. At z -8.0 the section should be 5.20 at
   * the knuckle, tucked at the deck edge and tucked much harder at the turn of
   * the bilge — which is what makes it an ore carrier's midship section rather
   * than a plate. */
  const soup = partSoup(['hull']);
  const at = (y) => {
    const hit = raycast(soup, 9.0, y, -8.0, -1, 0, 0, 6.0);
    return hit ? 9.0 - hit.t : null;
  };
  const knuckle = at(2.08), deck = at(4.20), bilge = at(1.00);
  assert.ok(knuckle > 5.18 && knuckle <= 5.201, `the knuckle is at ${knuckle}`);
  assert.ok(deck < knuckle - 0.05, `the deck edge (${deck}) is not tucked inside the knuckle`);
  assert.ok(bilge < knuckle - 0.35, `the turn of the bilge (${bilge}) is not tucked under the knuckle`);
});

test('the underside is not one flat plate', () => {
  /* The Dray's belly was the single largest flat on any hull in this yard —
   * `dock-hull-shape` measured 19.5% of her whole visible skin — and it is
   * the one surface she was completely free to shape. Fired straight up at the
   * keel on a grid: a flat bottom returns one height, this one returns a
   * spread, because the keel has 1.5 m of rocker aft and 1.7 m forward. */
  const soup = partSoup(['hull']);
  const ys = [];
  for (let i = 0; i <= 10; i++) {
    const z = -13.8 + i * 2.76;
    const hit = raycast(soup, 0, -2, z, 0, 1, 0, 6);
    if (hit) ys.push(-2 + hit.t);
  }
  assert.ok(ys.length >= 10, `the keel probe only found ${ys.length} of 11 stations`);
  const spread = Math.max(...ys) - Math.min(...ys);
  assert.ok(spread > 1.4, `the keel line varies by only ${spread.toFixed(2)} m — it is a plate again`);
});
