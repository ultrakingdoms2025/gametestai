/**
 * The acceptance gate for the station audit: inject defects we know the size
 * of, and check the instrument reports exactly those, at exactly that size.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * An audit's output is a list of numbers about a world nobody has measured by
 * hand. There is no way to tell a correct list from a plausible one by reading
 * it, and every failure mode of an instrument like this - a sampler that misses
 * the thing it aims at, a threshold applied to the wrong operand, a traversal
 * that quietly drops half the scene - produces output that looks exactly like a
 * clean world. So the numbers mean nothing until the instrument has been shown
 * a defect it did not know about and has named it correctly.
 *
 * Five injected cases, each with a magnitude asserted to +/- 0.01 m (or m3):
 *
 *   FLOAT       a box 0.50 m above its support
 *   SUNK        a box 0.30 m into its support
 *   OVERLAP     two boxes sharing exactly 0.50 m3
 *   NO_COLLIDER a drawn box with nothing registered in physics
 *   ESCALATOR   one flight's treads nudged 0.10 m out of alignment
 *
 * ...and one CONTROL box, placed correctly, which must NOT be reported by C1
 * or C2. A detector that flags everything passes the first five and fails this.
 *
 * ── This one DOES mutate the world ────────────────────────────────────────
 * Unlike the audit itself, which is strictly pure-read, this has to change the
 * scene to have anything to detect. Everything it adds is removed and
 * everything it moves is put back before it returns, including on the failure
 * path - see `restore`. The injection site is chosen from the world's own
 * occupancy grid so nothing is ever placed inside existing geometry.
 */

import * as THREE from 'three';
import { auditStation } from './StationAudit.js';
import { occKeyOf, OCC_CELL } from '../worlds/station/StationKit.js';

const TOL = 0.01;

/** Exactly the box the injected defects are made of: 1 m cube, easy arithmetic. */
const CUBE = 1;

/**
 * A patch of deck with nothing on it, found the same way the world's own
 * scatter finds one: through `_occupied`, the occupancy grid built from the
 * DRAWN geometry rather than from colliders (see `_markOccupancy`).
 *
 * Returns the ground height there as well, because everything below is measured
 * relative to the real local surface. Hard-coding "the deck is at y = 0" is
 * true of the deck plate and false of the road inlays, the grate platforms and
 * every plinth - and a self-test whose expected values are wrong is worse than
 * no self-test.
 */
function findClearSite(world, physics) {
  const occ = world._occupied;
  const need = 3;      // cells clear in every direction: ~4.5 m of elbow room
  for (let r = 46; r < 190; r += 1.5) {
    for (let a = 0; a < 360; a += 3) {
      const th = a * Math.PI / 180;
      const x = Math.cos(th) * r, z = Math.sin(th) * r;
      let clear = true;
      for (let i = -need; i <= need && clear; i++) {
        for (let j = -need; j <= need && clear; j++) {
          if (occ?.has(occKeyOf(x + i * OCC_CELL, z + j * OCC_CELL))) clear = false;
        }
      }
      if (!clear) continue;
      const base = physics.groundHeight(x, z, 60, 120);
      if (base === null) continue;
      // The whole patch has to be flat, or "0.50 m above the deck" is not.
      let flat = true;
      for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, 0], [8, 0], [-8, 0]]) {
        const h = physics.groundHeight(x + dx, z + dz, 60, 120);
        if (h === null || Math.abs(h - base) > 0.02) { flat = false; break; }
      }
      if (!flat) continue;
      // Nothing overhead, either: an injected box inside a soffit is not a test.
      if (physics.containsPoint(new THREE.Vector3(x, base + 1.5, z))) continue;
      return { x, z, base };
    }
  }
  return null;
}

/**
 * Inject one drawn box with its UNDERSIDE at `minY`, and no collider.
 * Returned so the caller can take it out again.
 */
function addBox(world, group, name, cx, minY, cz, size = CUBE) {
  const geo = new THREE.BoxGeometry(size, size, size);
  const mat = world.mat?.crate ?? world.mat?.panelDark ?? new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(cx, minY + size / 2, cz);
  mesh.updateMatrixWorld(true);
  group.add(mesh);
  return mesh;
}

const near = (a, b, tol = TOL) => a !== null && a !== undefined && Number.isFinite(a) && Math.abs(a - b) <= tol;

function findC1(report, name) {
  const c = report.checks.find((x) => x.name === 'C1_GROUNDING');
  return c?.findings.find((f) => f.meshName === name) ?? null;
}
function findC3(report, name) {
  const c = report.checks.find((x) => x.name === 'C3_COVERAGE');
  return c?.findings.find((f) => f.meshName === name) ?? null;
}
function findC2(report, nameA, nameB) {
  const c = report.checks.find((x) => x.name === 'C2_OVERLAP');
  return c?.findings.find((f) =>
    (f.a.meshName === nameA && f.b.meshName === nameB) ||
    (f.a.meshName === nameB && f.b.meshName === nameA)) ?? null;
}
function anyC2Mentioning(report, name) {
  const c = report.checks.find((x) => x.name === 'C2_OVERLAP');
  return c?.findings.some((f) => f.a.meshName === name || f.b.meshName === name) ?? false;
}

/**
 * Run the whole gate. Returns `{ pass, cases: [{name, pass, detail}], site }`.
 *
 * @param {object} game `window.GAME`
 */
export async function runSelfTest(game) {
  const world = game?.worldManager?.active;
  if (world?.id !== 'station') {
    return { pass: false, cases: [{ name: 'precondition', pass: false, detail: `active world is "${world?.id ?? 'none'}", not the station` }] };
  }
  const physics = game.physics;
  const cases = [];
  const added = [];
  const restore = [];

  try {
    const site = findClearSite(world, physics);
    if (!site) {
      return { pass: false, cases: [{ name: 'injection-site', pass: false, detail: 'no clear patch of deck found; nothing could be injected' }] };
    }
    const { x, z, base } = site;
    const group = world.group.getObjectByName('dressing');
    if (!group) {
      return { pass: false, cases: [{ name: 'injection-group', pass: false, detail: 'no "dressing" group to inject into' }] };
    }

    /* ── The injected defects ───────────────────────────────────────────
     * Laid out along +X from the site so no two of them touch except the
     * pair that is supposed to. Heights are measured from the site's own
     * ground, not assumed. */
    const FLOAT_GAP = 0.50, SUNK_GAP = 0.30, OVERLAP_SHIFT = 0.50;
    added.push(addBox(world, group, 'audit-selftest-float', x, base + FLOAT_GAP, z));
    added.push(addBox(world, group, 'audit-selftest-sunk', x + 3, base - SUNK_GAP, z));
    added.push(addBox(world, group, 'audit-selftest-overlap-a', x + 6, base, z));
    added.push(addBox(world, group, 'audit-selftest-overlap-b', x + 6 + OVERLAP_SHIFT, base, z));
    added.push(addBox(world, group, 'audit-selftest-nocollider', x + 10, base, z));
    added.push(addBox(world, group, 'audit-selftest-control', x + 14, base, z));
    world.group.updateMatrixWorld(true);

    const report = auditStation(game, { checks: ['C1', 'C2', 'C3'], maxFindings: 20000 });

    /* 1. FLOAT */
    {
      const f = findC1(report, 'audit-selftest-float');
      cases.push({
        name: 'FLOAT 0.50 m above the deck',
        pass: !!f && f.verdict === 'FLOAT' && near(f.gap, FLOAT_GAP),
        detail: f ? `verdict=${f.verdict} gap=${f.gap} (expected FLOAT ${FLOAT_GAP})` : 'not reported by C1',
      });
    }
    /* 2. SUNK */
    {
      const f = findC1(report, 'audit-selftest-sunk');
      cases.push({
        name: 'SUNK 0.30 m into the deck',
        pass: !!f && f.verdict === 'SUNK' && near(f.gap, -SUNK_GAP),
        detail: f ? `verdict=${f.verdict} gap=${f.gap} (expected SUNK ${-SUNK_GAP})` : 'not reported by C1',
      });
    }
    /* 3. OVERLAP - two 1 m cubes offset 0.50 m share 0.50 x 1 x 1 m3. */
    {
      const expected = (CUBE - OVERLAP_SHIFT) * CUBE * CUBE;
      const f = findC2(report, 'audit-selftest-overlap-a', 'audit-selftest-overlap-b');
      cases.push({
        name: `OVERLAP ${expected.toFixed(2)} m3`,
        pass: !!f && near(f.intersectionVolume, expected),
        detail: f ? `volume=${f.intersectionVolume} m3 (expected ${expected.toFixed(2)})` : 'not reported by C2',
      });
    }
    /* 4. NO_COLLIDER */
    {
      const f = findC3(report, 'audit-selftest-nocollider');
      cases.push({
        name: 'NO_COLLIDER (drawn, never collided)',
        pass: !!f && f.verdict === 'NO_COLLIDER' && f.collisionTrianglesInside === 0,
        detail: f ? `verdict=${f.verdict} trianglesInside=${f.collisionTrianglesInside}` : 'not reported by C3',
      });
    }
    /* 5. CONTROL - correctly placed, must not be called a placement defect. */
    {
      const c1 = findC1(report, 'audit-selftest-control');
      const c2 = anyC2Mentioning(report, 'audit-selftest-control');
      cases.push({
        name: 'CONTROL correctly placed (must NOT flag)',
        pass: !c1 && !c2,
        detail: c1 ? `wrongly flagged by C1: ${c1.verdict} gap=${c1.gap}`
          : c2 ? 'wrongly flagged by C2' : 'not flagged by C1 or C2, as required',
      });
    }

    /* 6. ESCALATOR - nudge one flight's treads and watch the deltas move.
     *
     * Measured as a CHANGE against this page's own baseline rather than
     * against an absolute expected height: the flights carry a deliberate
     * 0.10 m offset between the ramp collider and the tread line (see the
     * note in Tower.js), and a self-test that asserted an absolute value
     * would be asserting that design decision rather than the instrument. */
    {
      const bank = world._escalators?.[0];
      const run = bank?.runs?.[0];
      if (!bank?.mesh?.isInstancedMesh || !run) {
        cases.push({ name: 'ESCALATOR tread nudged 0.10 m', pass: false, detail: 'no escalator bank/run to nudge' });
      } else {
        const before = escalatorRun(auditStation(game, { checks: ['C4'] }), 0, 0);
        const arr = bank.mesh.instanceMatrix.array;
        const touched = [];
        for (let i = run.first; i < run.first + run.count && i < bank.mesh.count; i++) {
          const o = i * 16 + 13;                 // element 13 is the Y translation
          touched.push([o, arr[o]]);
          arr[o] += 0.10;
        }
        bank.mesh.instanceMatrix.needsUpdate = true;
        restore.push(() => {
          for (const [o, v] of touched) arr[o] = v;
          bank.mesh.instanceMatrix.needsUpdate = true;
        });

        const after = escalatorRun(auditStation(game, { checks: ['C4'] }), 0, 0);
        const dBottom = after && before ? after.bottom.deltas.treadVsFloor - before.bottom.deltas.treadVsFloor : null;
        const dTop = after && before ? after.top.deltas.treadVsFloor - before.top.deltas.treadVsFloor : null;
        cases.push({
          name: 'ESCALATOR tread nudged 0.10 m',
          pass: near(dBottom, 0.10) && near(dTop, 0.10),
          detail: before && after
            ? `treadVsFloor moved by ${dBottom?.toFixed(3)} (bottom) / ${dTop?.toFixed(3)} (top), expected 0.100`
            : 'C4 did not measure bank 0 run 0',
        });
      }
    }

    return { pass: cases.every((c) => c.pass), cases, site: { x: +x.toFixed(2), z: +z.toFixed(2), base: +base.toFixed(3) } };
  } finally {
    /* Put the world back exactly as it was found, whatever happened above.
     * The audit is run against this same page afterwards; leaving a synthetic
     * float in the scene would corrupt the very report this gate exists to
     * make trustworthy. */
    for (const fn of restore) { try { fn(); } catch { /* best effort */ } }
    for (const mesh of added) {
      mesh.parent?.remove(mesh);
      mesh.geometry?.dispose();
    }
    world.group.updateMatrixWorld(true);
  }
}

function escalatorRun(report, bank, run) {
  const c = report.checks.find((x) => x.name === 'C4_ESCALATOR');
  return c?.measurements?.find((m) => m.bank === bank && m.run === run) ?? null;
}
