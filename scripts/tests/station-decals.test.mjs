import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';

/**
 * IS ANYTHING DRAWN ON TOP OF THE PAINT?
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS FOR, AND WHY NOTHING ELSE COULD SEE IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The avenue legends were painted UNDER the inset light strips. The strip sat
 * at 6.36-6.78 m across the carriageway at y 0.14; a 4.2 m legend centred at
 * +/-5.4 spanned 3.30-7.50 at y 0.135. So the strip ran through every legend on
 * both sides of all six avenues, five millimetres proud of it, and won the
 * depth test. WALKWAY read as "ALKWAY".
 *
 * Nothing in the suite could see it, and nothing could have. Collision does not
 * care what is drawn; occupancy grids work in plan and both marks are flat;
 * the catalogue and anchor pins see one merged `deck` batch whose bounds do not
 * change. It is invisible to every geometric test here because it is not a
 * geometric error - both marks are exactly where they were authored. It is a
 * DEPTH error, and depth is only visible from above.
 *
 * Three probes, a 73-shot capture sweep, five screenshot reviewers and a ranker
 * all missed it. The owner found it by looking at one picture. This is the gate
 * that would have caught it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY "PARTIALLY COVERED" AND NOT "COVERED"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A crate standing on a painted lane also hides paint, and that is not a
 * defect - it is a crate on a floor, which is what floors are for. Measured on
 * the built station, 50 of 1,396 paint triangles have something opaque within
 * 0.6 m above them, and almost all of those are props resting on marked ground.
 *
 * What made the legend a defect is that it was PARTLY covered: a word with its
 * first letter missing reads as broken, where a word entirely under a crate
 * just reads as hidden. So the test is about partial occlusion of a triangle,
 * which needs no knowledge of props at all.
 *
 * A first attempt tried to separate the two by measuring the height of the
 * thing doing the covering - a flat trim strip being the defect and a tall
 * crate not. That does not work here and the reason is worth keeping:
 * `Box3.setFromObject` on a merged `GeoBatch` returns the bounds of the WHOLE
 * DISTRICT, so `dressing:trim` measured 56.50 m tall and every covering object
 * classified as "tall". It is the same merged-batch blindness `StationAudit`
 * records about itself. Do not reach for per-object bounds in this world.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH DECAL IS WHICH, AFTER MERGING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The quads are merged into one mesh, so there is no per-decal object left to
 * ask. But `atlasUV` wrote the atlas cell into the UVs, and that survives the
 * merge: `u = col/4 + u0/4`, `v = 1 - (row+1)/4 + v0/4`. Inverting it recovers
 * the cell, and `DECALS[cell]` names it. A legend is judged strictly; a stain
 * or a cable run is not judged at all, because dirt lying half under a crate is
 * what dirt does.
 */

/** `DECALS` in StationWorld.js, in atlas order. Restated because it is not exported. */
const DECALS = [
  'chevron', 'arrow', 'circle', 'keepclear',
  'number', 'radiation', 'noentry', 'crosshatch',
  'dock', 'grate', 'stain', 'cable',
  'stop', 'walk', 'load', 'vent',
];

/**
 * The cells that carry LETTERING, where a partial cover reads as a broken mark
 * rather than as a hidden one: a word with a letter missing.
 *
 * Deliberately narrow. `stain`, `cable`, `grate`, `vent` and `crosshatch` are
 * texture rather than marks. `circle`, `chevron`, `arrow`, `dock`, `noentry`
 * and `radiation` are graphic marks, and measured on the built station 42 of
 * them are partly under plaza props - a dock ring with a crate parked on it is
 * a floor being used, not a defect, and a gate that failed on those would be
 * noise nobody could act on. If those are ever wanted, they are a separate
 * judgement with a separate threshold, not a wider set here.
 */
const LEGENDS = new Set(['keepclear', 'stop', 'walk', 'load', 'number']);

/** How far above the paint counts as "drawn on it" rather than "overhead". */
const BAND = 0.6;

/** Barycentric sample points per triangle - corners pulled in, plus the centre. */
const BARY = [
  [0.62, 0.19, 0.19], [0.19, 0.62, 0.19], [0.19, 0.19, 0.62],
  [1 / 3, 1 / 3, 1 / 3], [0.45, 0.45, 0.10], [0.10, 0.45, 0.45], [0.45, 0.10, 0.45],
];

const _up = new THREE.Vector3(0, 1, 0);

test('no avenue legend is drawn across, and the plaza pads are on the record', async () => {
  const { world } = await buildStation();
  world.group.updateMatrixWorld(true);

  const paint = [];
  world.group.traverse((o) => {
    if (!o.isMesh || !o.visible || o.isInstancedMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const n = m?.name || '';
    if (n === 'station.decal' || n === 'station.route') paint.push(o);
  });
  assert.ok(paint.length > 0, 'no painted floor marks found at all - has the decal material been renamed?');

  const rc = new THREE.Raycaster();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ua = new THREE.Vector2(), ub = new THREE.Vector2(), uc = new THREE.Vector2();
  const p = new THREE.Vector3();

  /** Is the surface at `p` covered by something opaque within `BAND` above? */
  const coveredAt = (self) => {
    rc.set(p.setY(p.y + 0.005), _up);
    rc.far = BAND;
    return rc.intersectObject(world.group, true).some((h) => {
      if (!h.object.visible || h.object === self) return false;
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      if (!m || m.transparent || m.depthWrite === false) return false;
      const n = m.name || '';
      // Other paint at the same level is not "on top of" - that is the
      // coplanar-floor problem, which `CoplanarLevels` and `seamLift` own.
      return n !== 'station.decal' && n !== 'station.route' && n !== 'station.grime';
    });
  };

  const partial = new Map();
  let triangles = 0, legendTris = 0;

  for (const mesh of paint) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;

    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      triangles++;

      /* Which atlas cell, recovered from the UVs `atlasUV` wrote. The centre of
       * the triangle's UV is safely inside its own cell whatever the winding. */
      let cellName = null;
      if (uv) {
        ua.fromBufferAttribute(uv, i0); ub.fromBufferAttribute(uv, i1); uc.fromBufferAttribute(uv, i2);
        const u = (ua.x + ub.x + uc.x) / 3, v = (ua.y + ub.y + uc.y) / 3;
        const col = Math.min(3, Math.max(0, Math.floor(u * 4)));
        const row = Math.min(3, Math.max(0, 3 - Math.floor(v * 4)));
        cellName = DECALS[row * 4 + col] ?? null;
      }
      if (!cellName || !LEGENDS.has(cellName)) continue;
      legendTris++;

      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);

      let cov = 0;
      for (const [wa, wb, wc] of BARY) {
        p.set(a.x * wa + b.x * wb + c.x * wc, a.y * wa + b.y * wb + c.y * wc, a.z * wa + b.z * wb + c.z * wc);
        if (coveredAt(mesh)) cov++;
      }

      /* Wholly clear is right. Wholly hidden is a crate standing on it, which
       * is a floor doing its job. Anything between is a mark with a piece
       * taken out of it, which is what a player reads as broken. */
      if (cov > 0 && cov < BARY.length) {
        const key = `${cellName} at (${a.x.toFixed(0)}, ${a.z.toFixed(0)})`;
        partial.set(key, (partial.get(key) ?? 0) + 1);
      }
    }
  }

  console.log(`  ${triangles} painted triangles, ${legendTris} of them lettering or a drawn mark`);
  console.log(`  partly drawn over: ${partial.size} place(s)`);
  for (const [k, v] of [...partial].sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`     ${k} x${v}`);

  assert.ok(legendTris > 0, 'no legend decals were recognised - has the atlas order or the UV mapping changed?');

  /* ── The avenues: fixed, and held at zero ─────────────────────────────────
   * `walk`, `load`, `stop` and `number` are the legends placed along the six
   * avenues by `_buildDeck`, and every one of them was painted under the inset
   * light strip until the offset was derived from the strip instead of chosen.
   * Zero is the whole point of that change and there is no band on it. */
  const avenue = [...partial.keys()].filter((k) => !k.startsWith('keepclear'));
  assert.deepEqual(avenue, [], `${avenue.length} avenue legend(s) are drawn across again - check the strip/legend offsets in _buildDeck`);

  /* ── The plaza: fixed too, and also held at zero ─────────────────────────
   * The twelve `keepclear` pads that were partly covered were not placed as
   * signs at all. `_buildDressing`'s near-field pass is described in its own
   * note as "weighted onto stain / cable / dock cells, small and numerous",
   * and cell 3 - KEEP CLEAR - was in that weighting array. One mark in eight
   * of three hundred, so about thirty-seven LEGENDS were stamped through the
   * near field at 0.7 to 3.3 m: too small to read, and dense enough to land
   * under the props the same function scatters.
   *
   * Removing it took the recognised legend triangles from 184 to 104 and the
   * partly-covered count from twelve to none. The station lost no readable
   * sign - everything removed was illegible at the size it was drawn. */
  const plaza = [...partial.keys()].filter((k) => k.startsWith('keepclear'));
  assert.deepEqual(plaza, [], `${plaza.length} plaza KEEP CLEAR pads are partly drawn over`);
});
