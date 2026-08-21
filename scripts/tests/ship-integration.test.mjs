import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { harness, PLAN, CRADLE_TOP } from './_hullrig.mjs';

/**
 * ALL FOUR AUTHORED HULLS, TOGETHER, AND THE CONTRACTS THEY SHARE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS ALONGSIDE THE FOUR PER-HULL FILES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ship-assets`, `ship-dray`, `pike-assets` and `bastion-asset` were each
 * written by the agent that authored that hull, and each is deep on its own
 * shape — the Dray's hopper knuckle, the Pike's chine, the Bastion's ribs.
 * Being written one at a time, they are UNEVEN on the things that are not
 * about shape at all but about the pipeline every hull shares, and the gaps
 * were not the same gaps:
 *
 *   - the Dray never pinned its fallback, so `dray-hull.glb` could vanish and
 *     only a browser would notice;
 *   - the Dray never pinned the material contract, which is the one that
 *     decides whether an authored hull costs shader programs;
 *   - the Dray never pinned its vertices finite, which is the failure that
 *     rendered the Kestrel as a white screen with a ship-shaped hole;
 *   - and NOTHING anywhere pinned that a livery still paints an authored
 *     hull, which is the failure the brief names in as many words: "an
 *     authored mesh needs its material slots mapped to the same slot ids
 *     ShipMenu drives, or painting silently does nothing".
 *
 * So this file asks the shared questions once, of all four hulls, in a loop.
 * A fifth hull added to `SHIP_ASSET_HULLS` is picked up automatically and has
 * to answer all of them — which is the property the four per-hull files, being
 * per-hull, structurally cannot have.
 *
 * ── The one genuinely new claim: an added collider can BLOCK ──────────────
 * The per-hull files each prove the two arms register the SAME STRUCTURE and
 * name their differences. That is the bridge that carries `dock-reach`'s
 * reachability proof — which runs against the PROCEDURAL hull, because
 * `shipParts` is null under `node --test` — across to the authored one.
 *
 * The bridge has a hole in it. Parity is proved as a SET DIFFERENCE, and the
 * differences are allowed: the Pike gains three nose boxes and two under the
 * canopy blister, the Dray gains a box inside each external tank, the Bastion
 * gains twenty-one. Every one of those is an ADDITION to the collider set, and
 * an addition is exactly the thing that can stand in a doorway. `dock-reach`
 * has never seen one of them, and never can while it measures the fallback.
 *
 * So the last test takes the authored-only colliders — the ones no reach probe
 * has ever met — and holds them against the volumes `HullPlan` publishes as
 * places a body stands: the far end of every climb band, and the length of the
 * dorsal spine. `MedievalWorld` shipped a building whose own ore benches stood
 * across its own entrance; this is that check, for the boxes the reach probe
 * cannot see.
 */

harness();

const { Physics } = await import('../../src/physics/Physics.js');
const { GeoBatch } = await import('../../src/worlds/station/StationKit.js');
const { ShipBuild, shipMaterials } = await import('../../src/worlds/dock/ShipKit.js');
const HULLS_SRC = await import('../../src/worlds/dock/Hulls.js');
const ASSETS = await import('../../src/ships/ShipAssets.js');
const { SHIP_SLOTS, SHIP_TINTS } = await import('../../src/ships/ShipStats.js');
const { applyLivery } = await import('../../src/mounts/Livery.js');

const DIR = path.resolve('public/assets/ship');
const MANIFEST = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/** Hull id -> the builder that draws it. The Bastion is a hulk and still builds. */
const BUILDER = {
  kestrel: 'buildKestrel', dray: 'buildDray', pike: 'buildPike', bastion: 'buildBastion',
};
/** Every hull the loader claims an asset for. Drives every loop below. */
const HULL_IDS = Object.keys(ASSETS.SHIP_ASSET_HULLS);

/* The committed .glb files, parsed exactly as `ShipAssets.namedParts` parses
 * them — node transform baked in, mesh name kept as the material key. */
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
const PARSED = {};
for (const e of MANIFEST.assets) {
  const buf = readFileSync(path.join(DIR, e.file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  PARSED[e.id] = await new Promise((res, rej) => new GLTFLoader().parse(ab, DIR, res, rej));
}

/** id -> [{key, geometry}], the shape `ShipAssets` caches. */
function assetMap() {
  const out = {};
  for (const id in PARSED) {
    const parts = [];
    PARSED[id].scene.updateMatrixWorld(true);
    PARSED[id].scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      parts.push({ key: o.name, geometry: g });
    });
    out[id] = parts;
  }
  return out;
}

function stubMaterials() {
  const M = {};
  for (const k of ['plate', 'steel', 'glass', 'emCyan', 'steelDark', 'grate',
    'hazard', 'crate', 'tarp', 'emAmber', 'emSodium', 'emRed', 'signs']) {
    M[k] = new THREE.MeshStandardMaterial({ name: k });
  }
  return M;
}

/**
 * Build one hull with or without its authored skin.
 *
 * `installShipAssets` is the same door the browser's loader writes through, so
 * the authored arm here is the arm the player sees; `resetShipAssets` on the
 * way out keeps one hull's asset from leaking into the next one's build.
 */
function build(id, useAsset, side = 1) {
  ASSETS.resetShipAssets();
  if (useAsset) ASSETS.installShipAssets(assetMap());
  const physics = new Physics();
  const M = stubMaterials();
  const tint = SHIP_TINTS[id] ?? SHIP_TINTS.kestrel;
  const { mats, slotMats } = shipMaterials(M, tint);
  const ext = new GeoBatch();
  const int = new GeoBatch();
  const group = new THREE.Group();
  const cols = [];
  const b = new ShipBuild({
    batch: ext, interior: int, physics,
    track: (c) => { cols.push(c); return c; },
    group, x: 0, y: 0, z: 0, yaw: 0,
  });
  const result = HULLS_SRC[BUILDER[id]](b, side, CRADLE_TOP[id] ?? 0, mats);
  const extRoot = new THREE.Group();
  ext.flush(extRoot, mats, 'arm', {});
  const intRoot = new THREE.Group();
  int.flush(intRoot, mats, 'arm-in', {});
  extRoot.updateMatrixWorld(true);
  ASSETS.resetShipAssets();
  return { b, cols, extRoot, intRoot, result, mats, slotMats };
}

const triCount = (root) => {
  let n = 0;
  root.traverse((m) => {
    if (!m.isMesh) return;
    const idx = m.geometry.getIndex();
    n += (idx ? idx.count : m.geometry.attributes.position.count) / 3;
  });
  return n;
};

/** Material names an arm actually draws with. */
const materialNames = (root) => {
  const s = new Set();
  root.traverse((m) => { if (m.isMesh && m.material) s.add(m.material.name || String(m.material.uuid)); });
  return s;
};

/** Box collider signature: centre and half-extents, to the millimetre. */
const sig = (c) => {
  if (c.type !== 'box' || !c.matrix || !c.halfExtents) return null;
  const e = c.matrix.elements;
  return [e[12], e[13], e[14], c.halfExtents.x, c.halfExtents.y, c.halfExtents.z]
    .map((v) => v.toFixed(3)).join('|');
};

/** Both arms of every hull, built once. */
const ARMS = {};
for (const id of HULL_IDS) ARMS[id] = { asset: build(id, true), plain: build(id, false) };

/* ================================================================== */
/* 1. The registry, the manifest and the bytes on disk                 */
/* ================================================================== */

test('every hull the loader claims is declared by the manifest, and vice versa', () => {
  const declared = MANIFEST.assets.filter((a) => a.kind === 'geometry').map((a) => a.hull).sort();
  assert.deepEqual(HULL_IDS.slice().sort(), declared,
    'SHIP_ASSET_HULLS and the manifest must name the same hulls');
  assert.equal(HULL_IDS.length, 4);
});

test('the bytes on disk are the bytes the manifest declares, for all four', () => {
  for (const e of MANIFEST.assets) {
    const onDisk = statSync(path.join(DIR, e.file)).size;
    assert.equal(onDisk, e.bytes,
      `${e.file}: ${onDisk} bytes on disk, manifest declares ${e.bytes}`);
  }
});

test('the manifest triangle total is the triangle total in the file, for all four', () => {
  for (const e of MANIFEST.assets) {
    let n = 0;
    PARSED[e.id].scene.traverse((o) => {
      if (!o.isMesh) return;
      const idx = o.geometry.getIndex();
      n += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
    });
    assert.equal(n, e.tris, `${e.file}: ${n} triangles, manifest declares ${e.tris}`);
  }
});

/* ================================================================== */
/* 2. Both arms exist, for every hull                                  */
/* ================================================================== */

test('EVERY hull draws its authored skin, and it is not the procedural one', () => {
  for (const id of HULL_IDS) {
    const a = triCount(ARMS[id].asset.extRoot);
    const p = triCount(ARMS[id].plain.extRoot);
    assert.ok(a > 0 && p > 0, `${id}: both arms must draw something`);
    assert.notEqual(a, p, `${id}: the authored arm draws ${a}, the same as the procedural arm`);
  }
});

test('EVERY hull falls back silently when its file is absent', () => {
  /* The Kestrel and the Pike pinned this; the Dray and the Bastion did not, so
   * either could have lost its fallback with no test anywhere going red. */
  for (const id of HULL_IDS) {
    ASSETS.resetShipAssets();
    assert.equal(ASSETS.shipParts(id), null,
      `${id}: shipParts must be null with nothing loaded - that IS the fallback`);
    const built = build(id, false);
    assert.ok(triCount(built.extRoot) > 0, `${id}: the procedural hull must still build`);
    assert.ok(built.cols.length > 0, `${id}: the procedural hull must still collide`);
  }
});

test('EVERY hull loads exactly the parts its manifest entry declares', () => {
  ASSETS.installShipAssets(assetMap());
  try {
    for (const id of HULL_IDS) {
      const entry = MANIFEST.assets.find((a) => a.hull === id);
      const parts = ASSETS.shipParts(id);
      assert.ok(parts, `${id}: shipParts must return the authored parts once installed`);
      assert.deepEqual(parts.map((p) => p.key).sort(), entry.parts.slice().sort(),
        `${id}: the loaded part keys must be the ones the manifest declares`);
    }
  } finally { ASSETS.resetShipAssets(); }
});

/* ================================================================== */
/* 3. The performance contract: no material, therefore no program      */
/* ================================================================== */

test('NO hull adds a material, and therefore none of them adds a shader program', () => {
  /* The maze recorded the trap: a loaded glTF material is its own program
   * family. Measured live in the browser for all four at once, the yard came
   * to 275 programs with the assets and 275 with all four 404'd; this is the
   * headless form of that measurement, and it is the one that runs on every
   * commit. */
  for (const id of HULL_IDS) {
    const a = materialNames(ARMS[id].asset.extRoot);
    const p = materialNames(ARMS[id].plain.extRoot);
    const extra = [...a].filter((m) => !p.has(m));
    assert.deepEqual(extra, [],
      `${id}: the authored arm draws with materials the procedural arm does not: ${extra.join(', ')}`);
  }
});

test('NO authored vertex anywhere is non-finite', () => {
  /* 148 NaN uvs on the Kestrel rendered the whole frame as a white screen with
   * a ship-shaped hole. The generator gates it now; this gates the artefact. */
  for (const id in PARSED) {
    PARSED[id].scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const name in o.geometry.attributes) {
        const arr = o.geometry.attributes[name].array;
        for (let i = 0; i < arr.length; i++) {
          assert.ok(Number.isFinite(arr[i]),
            `${id}: mesh '${o.name}' attribute '${name}' index ${i} is ${arr[i]}`);
        }
      }
    });
  }
});

/* ================================================================== */
/* 4. The customizer still paints the hull it is pointed at            */
/* ================================================================== */

test('the authored skin is drawn with the very materials the livery slots paint', () => {
  /* THE FAILURE THIS EXISTS FOR, in the brief's own words: "an authored mesh
   * needs its material slots mapped to the same slot ids ShipMenu drives, or
   * painting silently does nothing".
   *
   * `ShipBuild.put` takes the mesh's NAME as a material key straight to
   * `GeoBatch`, so the proof is object identity: the mesh carrying the
   * authored `hull` geometry must be drawn with the SAME material instance
   * that `shipMaterials` hands to `Livery.applyLivery` as the `hull` slot. A
   * clone would paint and never show. */
  const SLOT_OF_KEY = { hull: 'hull', trim: 'trim', accent: 'accent', glass: 'canopy', glow: 'thruster' };
  let checked = 0;
  for (const id of HULL_IDS) {
    const slots = SHIP_SLOTS[id];
    if (!slots) continue;                       // the hulk sells no slots
    const { extRoot, slotMats } = ARMS[id].asset;
    const parts = assetMap()[ASSETS.SHIP_ASSET_HULLS[id]];
    for (const part of parts) {
      const slotId = SLOT_OF_KEY[part.key];
      if (!slotId) continue;                    // 'dark' is yard steel, deliberately unpainted
      const entry = slotMats[slotId]?.[0];
      const mat = entry?.mat ?? entry;
      assert.ok(mat, `${id}: slot '${slotId}' publishes no material`);
      let found = null;
      extRoot.traverse((m) => { if (m.isMesh && m.material === mat) found = m; });
      assert.ok(found,
        `${id}: no mesh is drawn with the '${slotId}' slot material, so painting it shows nothing`);
      const idx = found.geometry.getIndex();
      const tris = (idx ? idx.count : found.geometry.attributes.position.count) / 3;
      const pidx = part.geometry.getIndex();
      const authored = (pidx ? pidx.count : part.geometry.attributes.position.count) / 3;
      assert.ok(tris >= authored,
        `${id}: the '${slotId}' bucket carries ${tris} triangles, fewer than the ${authored} authored ones - the authored geometry is not in the painted bucket`);
      checked++;
    }
  }
  assert.ok(checked >= 15, `only ${checked} authored part/slot pairs were checked`);
});

test('painting an authored hull moves every slot, and resetting puts it back', () => {
  const PAINT = 0xff00c8;
  let hulls = 0;
  for (const id of HULL_IDS) {
    const slots = SHIP_SLOTS[id];
    if (!slots) continue;
    const { slotMats } = ARMS[id].asset;
    const before = {}, painted = {}, after = {};
    const readInto = (o) => {
      for (const s of slots) {
        const e = slotMats[s.id]?.[0];
        const m = e?.mat ?? e;
        o[s.id] = { c: m.color.getHex(), e: m.emissive ? m.emissive.getHex() : null };
      }
    };
    readInto(before);
    applyLivery(Object.fromEntries(slots.map((s) => [s.id, { color: PAINT }])), slots, slotMats);
    readInto(painted);
    applyLivery({}, slots, slotMats);
    readInto(after);
    for (const s of slots) {
      assert.notDeepEqual(painted[s.id], before[s.id],
        `${id}: slot '${s.id}' did not change colour when it was painted`);
      const isEmissive = slotMats[s.id][0]?.emissive === true;
      assert.equal(isEmissive ? painted[s.id].e : painted[s.id].c, PAINT,
        `${id}: slot '${s.id}' was painted ${PAINT.toString(16)} and did not take it`);
      assert.deepEqual(after[s.id], before[s.id],
        `${id}: slot '${s.id}' did not go back to the factory colour`);
    }
    hulls++;
  }
  assert.equal(hulls, 3, 'the three fitted hulls all sell livery slots; the hulk sells none');
});

/* ================================================================== */
/* 5. The colliders no reach probe has ever met                        */
/* ================================================================== */

test('the authored-only colliders stand nowhere a body is published to stand', () => {
  /* `dock-reach` floods the PROCEDURAL hull, because `shipParts` is null under
   * `node --test`. Collider parity carries that proof across to the authored
   * arm — except for the boxes the authored arm ADDS, which parity names and
   * allows and no probe has ever walked into.
   *
   * `HullPlan` publishes where a body stands: the far end of each climb band
   * (`standX`, `to`, `z`) and the length of the dorsal spine. A capsule of the
   * player's own radius is placed at each, and no authored-only box may be
   * inside it. */
  const R = 0.35;          // CONFIG.player.radius
  const STANCE = 1.8;      // the capsule height a standing body occupies
  const CLEAR = 0.05;      // a box level with the deck IS the deck, not an obstruction
  const report = [];
  for (const id of HULL_IDS) {
    const A = new Map(), P = new Map();
    for (const c of ARMS[id].asset.cols) { const s = sig(c); if (s) A.set(s, c); }
    for (const c of ARMS[id].plain.cols) { const s = sig(c); if (s) P.set(s, c); }
    const onlyA = [...A.keys()].filter((k) => !P.has(k));
    assert.ok(onlyA.length > 0,
      `${id}: no authored-only collider at all - the authored arm is not registering its own structure`);
    const H = PLAN.HULLS[id];
    const spots = [];
    for (const band of H.bands ?? []) {
      spots.push({ what: `band "${band.what}"`, x: band.standX, y: band.to, z: band.z });
    }
    if (H.spine) {
      for (let t = 0; t <= 1.0001; t += 0.05) {
        spots.push({ what: 'the dorsal spine', x: 0, y: H.spine.y, z: H.spine.z0 + t * (H.spine.z1 - H.spine.z0) });
      }
    }
    for (const k of onlyA) {
      const c = A.get(k);
      const e = c.matrix.elements;
      const [cx, cy, cz] = [e[12], e[13], e[14]];
      const { x: hx, y: hy, z: hz } = c.halfExtents;
      for (const s of spots) {
        const inXZ = Math.abs(cx - s.x) < hx + R && Math.abs(cz - s.z) < hz + R;
        const inY = (cy + hy) > s.y + CLEAR && (cy - hy) < s.y + STANCE;
        if (inXZ && inY) {
          report.push(`${id}: an authored-only box at (${cx.toFixed(2)}, ${cy.toFixed(2)}, ${cz.toFixed(2)}) stands in ${s.what}`);
        }
      }
    }
  }
  assert.deepEqual(report, [], report.join('\n'));
});
