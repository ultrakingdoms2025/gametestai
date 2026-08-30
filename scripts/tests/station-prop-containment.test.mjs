import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStation, THREE } from './world-kit.mjs';
import { collectParts, fractionInside, isDesignedContainer } from '../../src/dev/GeoParts.js';

/**
 * NO SCATTERED PROP STANDS INSIDE AUTHORED STRUCTURE.
 *
 * The dressing pass runs at 0.95, after every district, and until 2026-08-30
 * its near-field scatter loop had never asked what was already there - it
 * tested the radius band, the gateway bubbles and the road centrelines, all
 * geometry it computed itself. So it put props in planters and on plinths, and
 * the two the owner reported by eye were a barrier 39% inside a planter rim and
 * a bollard inside a plinth.
 *
 * ── The three filters, each of which was learned the expensive way ────────
 *
 * 1. EXACT, not boxes. A box sweep over this population returns candidate
 *    lists nobody can triage - "a building IS a set of overlapping boxes".
 *    Sampling the prop's actual surface against the host's actual triangles
 *    took 135 candidate pairs to 3 in the sign case.
 *
 * 2. VOLUMETRIC props only. A plane is excluded whatever its orientation:
 *    flat in Y is a floor decal, flat in Z is a poster on a wall, and neither
 *    can be "inside" what it is painted on in any sense a player notices. At
 *    the planter site 29 hits collapsed to 6 once thickness was required, and
 *    23 of the 29 were paint.
 *
 * 3. DESIGNED CONTAINERS excluded, by an explicit list - see
 *    `isDesignedContainer`. Ray parity answers "is A inside B" and never
 *    "should A be inside B"; the second question is architectural and cannot
 *    be derived. The hull pillars swallow 15 props that are standing correctly
 *    on open deck, photographed.
 *
 * ── Why a ratchet ─────────────────────────────────────────────────────────
 *
 * Ten remain, in four host groups, and each needs its own investigation: the
 * near-field fix cleared eight of eighteen and the rest come from other
 * placement paths. Zero would fail on arrival and be disabled within a day.
 * Lower it when you clear one; a rise means a placement pass started putting
 * props inside the world again.
 */

const CEILING = 10;
/** Below this in ANY dimension the piece is paint, not an object. */
const FLAT = 0.15;

const isDressing = (p) => p.owner === 'Scattering set dressing' || p.owner === 'dressing'
  || (p.instanced && /dressing/.test(p.mesh));

test('no scattered prop stands inside authored structure', async () => {
  const { world } = await buildStation();
  const all = collectParts(world.group);
  const size = new THREE.Vector3(), c = new THREE.Vector3();

  const street = all.filter((p) => {
    p.box.getSize(size);
    /* Floors, hull rings and dome beams span districts and are not what a
     * placement defect is about; two triangles is the minimum that can be a
     * surface at all. */
    return Math.max(size.x, size.z) <= 30 && p.box.min.y <= 20 && p.tris >= 2;
  });
  const props = street.filter((p) => {
    if (!isDressing(p)) return false;
    p.box.getSize(size);
    return Math.min(size.x, size.y, size.z) >= FLAT;
  });
  const hosts = street.filter((p) => !isDressing(p) && p.tris >= 4 && !isDesignedContainer(p));

  assert.ok(props.length > 800, `expected the station's dressing, found ${props.length} volumetric pieces`);
  assert.ok(hosts.length > 10000, `expected the station's structure, found ${hosts.length} hosts`);

  const inside = [];
  for (const a of props) {
    for (const b of hosts) {
      if (!a.box.intersectsBox(b.box)) continue;
      const frac = fractionInside(a, b);
      if (frac < 0.5) continue;
      a.box.getCenter(c);
      inside.push(`${(frac * 100).toFixed(0)}% of ${a.mesh}#${a.index} is inside ${b.mesh}#${b.index}`
        + ` at ${c.x.toFixed(0)},${c.y.toFixed(1)},${c.z.toFixed(0)}`);
      break;
    }
  }

  console.log(`  ${props.length} volumetric dressing pieces, ${hosts.length} hosts, ${inside.length} inside (ceiling ${CEILING})`);
  for (const line of inside) console.log(`    ${line}`);

  assert.ok(inside.length <= CEILING,
    `${inside.length} props stand inside structure, ceiling ${CEILING}. Lower it when you clear one; `
    + `a rise means a placement pass started putting props inside the world again.\n  `
    + inside.join('\n  '));
});
